import SwiftUI
import UniformTypeIdentifiers

@main struct WorkspaceHealthApp: App { var body: some Scene { WindowGroup { HealthHome() } } }

@MainActor final class HealthModel: ObservableObject {
    @Published var credentials: BridgeCredentials?
    @Published var commands: [WeightCommand] = []
    @Published var busy = false
    @Published var status = "Pair with your Mac to begin."
    @Published var error: String?
    @Published var dayCount = 0
    @Published var sleepStatus = "Sleep history has not been imported in this session."
    @Published var importingHistory = false
    var cancelHistory = false
    let health = HealthStore()
    struct Saved: Decodable { let saved: Bool }
    struct Commands: Decodable { let commands: [WeightCommand] }
    init() { do { credentials = try BridgeKeychain.load(); if credentials != nil { status = "Ready to sync with your Mac." } } catch { self.error = error.localizedDescription } }
    func authorize() async { guard !busy else { return }; busy = true; error = nil; defer { busy = false }; do { try await health.authorize(); UserDefaults.standard.set(true, forKey: "healthPermissionsRequested"); status = "Health permissions reviewed. You can sync accessible data." } catch { self.error = error.localizedDescription } }
    func pair(_ url: URL) async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url); guard data.count <= 64000 else { throw BridgeError.message("Choose the small pairing JSON file from your Mac.") }
            let pairing = try bridgeDecoder().decode(PairingFile.self, from: data)
            credentials = try await BridgeClient.pair(pairing); status = "Paired. Keep both devices on the same Wi-Fi."
        } catch { self.error = error.localizedDescription }
    }
    func sync() async {
        guard !busy, let credentials else { return }; busy = true; error = nil; defer { busy = false }
        do {
            let client = try BridgeClient(credentials)
            health.refreshCalendar()
            let snapshot = try await health.snapshot()
            let _: Saved = try await client.call("snapshot", body: bridgeEncoder().encode(snapshot))
            let calendar = health.calendar, today = calendar.startOfDay(for: Date())
            let batch = try await health.sleepBatch(from: calendar.date(byAdding: .day, value: -29, to: today)!, to: calendar.date(byAdding: .day, value: 1, to: today)!)
            let _: Saved = try await client.call("sleep-batch", body: bridgeEncoder().encode(batch))
            sleepStatus = "Recent sleep stages and daily context synced."
            let pending: Commands = try await client.call("commands")
            var review: [WeightCommand] = []
            for command in pending.commands {
                if let receipt = credentials.receipts[command.id] {
                    guard receipt == command.payloadHash else { throw BridgeError.message("A health request changed after it was saved. Check the Mac’s health queue.") }
                    let _: Saved = try await client.call("receipt", body: JSONSerialization.data(withJSONObject: ["id": command.id, "payloadHash": receipt]))
                } else { review.append(command) }
            }
            commands = review; dayCount = snapshot.days.count
            status = "Synced at \(Date().formatted(date: .omitted, time: .shortened))."
        } catch { self.error = error.localizedDescription }
    }
    func importHistory(from requested: Date) async {
        guard !busy, let credentials else { return }; busy = true; importingHistory = true; cancelHistory = false; error = nil
        defer { busy = false; importingHistory = false }
        do {
            health.refreshCalendar()
            let client = try BridgeClient(credentials), calendar = health.calendar
            var cursor = calendar.startOfDay(for: requested)
            let end = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date()))!
            while cursor < end && !cancelHistory {
                let next = min(calendar.date(byAdding: .day, value: 30, to: cursor)!, end)
                sleepStatus = "Importing \(cursor.formatted(date: .abbreviated, time: .omitted))…"
                let batch = try await health.sleepBatch(from: cursor, to: next)
                let _: Saved = try await client.call("sleep-batch", body: bridgeEncoder().encode(batch))
                cursor = next
                sleepStatus = "Saved history through \(next.addingTimeInterval(-1).formatted(date: .abbreviated, time: .omitted))."
            }
            if cancelHistory { sleepStatus += " Import stopped; completed ranges are kept." }
            else { sleepStatus = "Sleep history imported. Open Sleep on your Mac." }
        } catch { self.error = error.localizedDescription; sleepStatus += " Completed ranges are kept. Retrying is safe." }
    }
    func save(_ command: WeightCommand) async {
        guard !busy, var credentials else { return }; busy = true; error = nil; defer { busy = false }
        do {
            if let receipt = credentials.receipts[command.id], receipt != command.payloadHash { throw BridgeError.message("This health request changed after it was saved.") }
            if credentials.receipts[command.id] == nil { try await health.saveWeight(command); credentials.receipts[command.id] = command.payloadHash; try BridgeKeychain.save(credentials); self.credentials = credentials }
            let _: Saved = try await BridgeClient(credentials).call("receipt", body: JSONSerialization.data(withJSONObject: ["id": command.id, "payloadHash": command.payloadHash]))
            commands.removeAll { $0.id == command.id }; status = "Weight saved to Apple Health. Sync to update your Mac."
        } catch { self.error = error.localizedDescription }
    }
    func unpair() { BridgeKeychain.remove(); credentials = nil; commands = []; status = "Pair with your Mac to begin." }
}

struct HealthHome: View {
    @StateObject private var model = HealthModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var importing = false
    @State private var selected: WeightCommand?
    @State private var confirmUnpair = false
    @State private var historyFrom = Calendar.current.date(from: DateComponents(year: 2020, month: 1, day: 1))!
    var body: some View {
        NavigationStack {
            healthList
            .navigationTitle("Workspace Health")
            .toolbar { if model.importingHistory { Button("Stop import") { model.cancelHistory = true } } }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                switch result { case .success(let url): Task { await model.pair(url) }; case .failure(let error): model.error = error.localizedDescription }
            }
            .alert("Save weight to Apple Health?", isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } }), presenting: selected) { command in
                Button("Save measurement") { Task { await model.save(command) }; selected = nil }
                Button("Cancel", role: .cancel) { selected = nil }
            } message: { command in Text("\(command.kg, specifier: "%.2f") kg, measured \(command.measuredAt.formatted()). This creates a manual weight entry in Apple Health.") }
            .confirmationDialog("Forget this Mac pairing?", isPresented: $confirmUnpair) { Button("Forget pairing", role: .destructive) { model.unpair() } }
            .onChange(of: scenePhase) { _, phase in if phase == .active && UserDefaults.standard.bool(forKey: "healthPermissionsRequested") { Task { await model.sync() } } }
            .task { if UserDefaults.standard.bool(forKey: "healthPermissionsRequested") { await model.sync() } }
        }.tint(.teal)
    }
    private var healthList: some View {
        List {
            permissionsSection
            macSection
            sleepSection
            if model.dayCount > 0 { Section { Text("Latest snapshot: \(model.dayCount) calendar days. Missing values mean no accessible data, not zero.") } }
            entriesSection
            if let error = model.error { Section { Text(error).foregroundStyle(.red) } }
            if model.busy { ProgressView("Working…") }
        }
    }
    private var permissionsSection: some View {
        Section {
            Label("Your health, in your workspace", systemImage: "heart.text.square.fill").font(.headline).foregroundStyle(.teal)
            Text("Share steps, sleep stages, workouts, resting heart rate, HRV, active energy, exercise minutes, respiratory rate, oxygen saturation, and weight with your Mac. Only accessible data is included.")
            Button("Review Health permissions") { Task { await model.authorize() } }.disabled(model.busy)
        }
    }
    private var macSection: some View {
        Section {
            if let credentials = model.credentials {
                Label(credentials.url.host ?? "Paired Mac", systemImage: "desktopcomputer")
                Text(model.status)
                Button("Sync now", systemImage: "arrow.triangle.2.circlepath") { Task { await model.sync() } }.disabled(model.busy)
                Button("Forget this pairing", role: .destructive) { confirmUnpair = true }.disabled(model.busy)
            } else {
                Text("On your Mac, open Workspace → Health → iPhone setup. Enable sync and AirDrop the pairing file to this iPhone, then select it below.")
                Button("Import pairing file", systemImage: "link") { importing = true }.disabled(model.busy)
            }
        } header: { Text("Your Mac") } footer: { Text("The Mac must be awake with Workspace running, and both devices must be on the same Wi-Fi. Sync runs while this app is open. No background delivery is promised.") }
    }
    private var sleepSection: some View {
        Section {
            DatePicker("History from", selection: $historyFrom, in: Calendar.current.date(from: DateComponents(year: 2010, month: 1, day: 1))!...Date(), displayedComponents: .date).disabled(model.busy)
            Button("Import sleep history", systemImage: "moon.zzz") { Task { await model.importHistory(from: historyFrom) } }.disabled(model.busy || model.credentials == nil)
            Text(model.sleepStatus).font(.subheadline)
        } header: { Text("Sleep history") } footer: { Text("Review Health permissions after updating this app. Regular sync refreshes 30 days; this imports older stages and daily context in batches. Keep the app open and your Mac awake. Import again to refresh older deletions or corrections. Unavailable readings remain missing.") }
    }
    @ViewBuilder private var entriesSection: some View {
        if !model.commands.isEmpty {
            Section {
                ForEach(model.commands) { command in
                    Button { selected = command } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Weight · \(command.kg, specifier: "%.2f") kg")
                            Text(command.measuredAt.formatted()).font(.caption).foregroundStyle(.secondary)
                        }
                    }.disabled(model.busy)
                }
            } header: { Text("Review entries from your Mac") } footer: { Text("Each measurement is saved only after you review and confirm it here.") }
        }
    }

}
