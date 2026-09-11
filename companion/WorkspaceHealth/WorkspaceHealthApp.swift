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
            let snapshot = try await health.snapshot()
            let _: Saved = try await client.call("snapshot", body: bridgeEncoder().encode(snapshot))
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
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("Your health, in your workspace", systemImage: "heart.text.square.fill").font(.headline).foregroundStyle(.teal)
                    Text("Share steps, sleep, workouts, resting heart rate, and weight with your Mac. Only accessible data is included.")
                    Button("Review Health permissions") { Task { await model.authorize() } }
                }
                Section("Your Mac") {
                    if let credentials = model.credentials {
                        Label(credentials.url.host ?? "Paired Mac", systemImage: "desktopcomputer")
                        Text(model.status)
                        Button("Sync now", systemImage: "arrow.triangle.2.circlepath") { Task { await model.sync() } }
                        Button("Forget this pairing", role: .destructive) { confirmUnpair = true }
                    } else {
                        Text("On your Mac, open Workspace → Health → iPhone setup. Enable sync and AirDrop the pairing file to this iPhone, then select it below.")
                        Button("Import pairing file", systemImage: "link") { importing = true }
                    }
                } footer: { Text("The Mac must be awake with Workspace running, and both devices must be on the same Wi-Fi. Sync runs while this app is open. No background delivery is promised.") }
                if model.dayCount > 0 { Section { Text("Latest snapshot: \(model.dayCount) calendar days. Missing values mean no accessible data, not zero.") } }
                if !model.commands.isEmpty {
                    Section("Review entries from your Mac") {
                        ForEach(model.commands) { command in
                            Button { selected = command } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text("Weight · \(command.kg, specifier: "%.2f") kg")
                                    Text(command.measuredAt.formatted()).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    } footer: { Text("Each measurement is saved only after you review and confirm it here.") }
                }
                if let error = model.error { Section { Text(error).foregroundStyle(.red) } }
                if model.busy { ProgressView("Working…") }
            }
            .navigationTitle("Workspace Health")
            .disabled(model.busy)
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
}
