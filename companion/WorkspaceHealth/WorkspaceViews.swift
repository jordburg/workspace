import SwiftUI
import UniformTypeIdentifiers
import PhotosUI
import CoreTransferable
import AVKit
import UIKit

// MARK: - App shell

enum WorkspaceTab: Hashable {
    case today
    case capture
    case tasks
    case climbing
    case lesson
}

private enum WorkspaceDestination: String, CaseIterable, Identifiable, Hashable {
    case today
    case tasks
    case captures
    case mail
    case climbing
    case chess
    case health
    case finance
    case writing
    case settings

    var id: Self { self }

    var title: String {
        switch self {
        case .today: "Today"
        case .tasks: "Tasks"
        case .captures: "Captures"
        case .mail: "Mail"
        case .climbing: "Climbing"
        case .chess: "Chess"
        case .health: "Health"
        case .finance: "Finances"
        case .writing: "Writing"
        case .settings: "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .today: "sun.max"
        case .tasks: "checklist"
        case .captures: "tray.full"
        case .mail: "envelope"
        case .climbing: "mountain.2"
        case .chess: "crown"
        case .health: "heart"
        case .finance: "wallet.bifold"
        case .writing: "square.and.pencil"
        case .settings: "gearshape"
        }
    }

    static let dayToDay: [Self] = [.today, .tasks, .captures, .mail]
    static let areas: [Self] = [.climbing, .chess, .health, .finance, .writing]
}

private enum MoreRoute: Hashable {
    case chess
    case finance
    case mail
    case settings
    case writing
}

private func prefixByUTF16Units(_ value: String, limit: Int) -> String {
    var result = ""
    var used = 0
    for character in value {
        let width = String(character).utf16.count
        guard used + width <= limit else { break }
        result.append(character)
        used += width
    }
    return result
}

struct WorkspaceRootView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: WorkspaceTab = .today
    @State private var selectedDay = Date()
    @State private var showingSettings = false
    @State private var tabletDestination: WorkspaceDestination? = .today

    var body: some View {
        ZStack {
            if UIDevice.current.userInterfaceIdiom == .pad {
                WorkspaceTabletShell(
                    selection: $tabletDestination,
                    selectedDay: $selectedDay
                )
            } else {
                phoneShell
            }
            if scenePhase != .active {
                WorkspacePrivacyCover()
                    .transition(.opacity)
                    .zIndex(10)
            }
        }
        .tint(WorkspaceBrand.signal)
        .task {
            await store.loadInitial()
            if store.managesAppleHealth,
               UserDefaults.standard.bool(forKey: "healthPermissionsRequested") {
                await store.syncHealth()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else {
                store.persistCaptureState()
                return
            }
            Task {
                if store.needsForegroundRefresh {
                    await store.refreshAll()
                    if store.managesAppleHealth,
                       UserDefaults.standard.bool(forKey: "healthPermissionsRequested") {
                        await store.syncHealth()
                    }
                } else {
                    await store.flushCaptureOutbox()
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            ZStack {
                NavigationStack {
                    SettingsWorkspaceView()
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { showingSettings = false }
                            }
                        }
                }
                if scenePhase != .active {
                    WorkspacePrivacyCover()
                        .transition(.opacity)
                        .zIndex(10)
                }
            }
        }
    }

    private func openSettings() {
        showingSettings = true
    }

    private var phoneShell: some View {
        TabView(selection: $tab) {
            NavigationStack {
                TodayView(
                    selectedDay: $selectedDay,
                    openTasks: { tab = .tasks },
                    openSettings: openSettings
                )
            }
            .tabItem { Label("Today", systemImage: "sun.max") }
            .tag(WorkspaceTab.today)

            NavigationStack {
                CaptureView(openSettings: openSettings)
            }
            .tabItem { Label("Capture", systemImage: "square.and.pencil") }
            .tag(WorkspaceTab.capture)

            NavigationStack {
                TasksView(openSettings: openSettings)
            }
            .tabItem { Label("Tasks", systemImage: "checklist") }
            .tag(WorkspaceTab.tasks)

            NavigationStack {
                ClimbingView(selectedDay: $selectedDay, openSettings: openSettings)
            }
            .tabItem { Label("Climbing", systemImage: "mountain.2") }
            .tag(WorkspaceTab.climbing)

            NavigationStack {
                ChessWorkspaceView(openSettings: openSettings)
            }
            .tabItem { Label("Lesson", systemImage: "checkerboard.rectangle") }
            .tag(WorkspaceTab.lesson)
        }
    }
}

private struct WorkspaceTabletShell: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Binding var selection: WorkspaceDestination?
    @Binding var selectedDay: Date

    private var destination: WorkspaceDestination { selection ?? .today }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    Button {
                        selection = .today
                    } label: {
                        HStack(spacing: 11) {
                            WorkspaceBrandMark(size: 34)
                            HStack(spacing: 0) {
                                Text("workspace")
                                    .font(.title3.weight(.semibold))
                                    .foregroundStyle(WorkspaceBrand.ink)
                                Text(".")
                                    .font(.title3.weight(.semibold))
                                    .foregroundStyle(WorkspaceBrand.signal)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)

                    HStack(spacing: 11) {
                        Text("JB")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(WorkspaceBrand.muted)
                            .frame(width: 34, height: 34)
                            .background(WorkspaceBrand.surface, in: Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Jordan Burgess")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(WorkspaceBrand.ink)
                            Text("Personal workspace")
                                .font(.caption)
                                .foregroundStyle(WorkspaceBrand.muted)
                        }
                    }
                    .listRowBackground(Color.clear)
                }

                sidebarSection("Day to day", destinations: WorkspaceDestination.dayToDay)
                sidebarSection("Areas", destinations: WorkspaceDestination.areas)

                Section {
                    sidebarRow(.settings)
                    HStack(spacing: 8) {
                        Circle()
                            .fill(store.isOnline ? Color.green : WorkspaceBrand.muted)
                            .frame(width: 7, height: 7)
                        Text(connectionLabel)
                            .font(.caption)
                            .foregroundStyle(WorkspaceBrand.muted)
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(WorkspaceBrand.canvas)
            .navigationSplitViewColumnWidth(min: 215, ideal: 242, max: 270)
        } detail: {
            NavigationStack {
                tabletDestination(destination)
                    .navigationDestination(for: MoreRoute.self) { route in
                        moreDestination(route)
                    }
            }
            .id(destination)
            .background(WorkspaceBrand.canvas)
        }
        .navigationSplitViewStyle(.balanced)
    }

    @ViewBuilder
    private func sidebarSection(_ title: String, destinations: [WorkspaceDestination]) -> some View {
        Section(title) {
            ForEach(destinations) { destination in
                sidebarRow(destination)
            }
        }
    }

    private func sidebarRow(_ destination: WorkspaceDestination) -> some View {
        HStack(spacing: 12) {
            Image(systemName: destination.symbol)
                .frame(width: 20)
            Text(destination.title)
            Spacer(minLength: 6)
            if let count = badgeCount(for: destination), count > 0 {
                Text(count.formatted())
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(WorkspaceBrand.muted)
            }
        }
        .foregroundStyle(selection == destination ? WorkspaceBrand.ink : WorkspaceBrand.muted)
        .tag(destination)
    }

    @ViewBuilder
    private func tabletDestination(_ destination: WorkspaceDestination) -> some View {
        switch destination {
        case .today:
            TabletTodayView(
                selectedDay: $selectedDay,
                openTasks: { selection = .tasks },
                openCaptures: { selection = .captures },
                openMail: { selection = .mail },
                openChess: { selection = .chess },
                openSettings: { selection = .settings }
            )
        case .tasks:
            TasksView(openSettings: { selection = .settings })
        case .captures:
            TabletCapturesView(openSettings: { selection = .settings })
        case .mail:
            MailWorkspaceView()
        case .climbing:
            ClimbingView(selectedDay: $selectedDay, openSettings: { selection = .settings })
        case .chess:
            TabletChessWorkspaceView(openSettings: { selection = .settings })
        case .health:
            HealthWorkspaceView(selectedDay: $selectedDay, openSettings: { selection = .settings })
        case .finance:
            FinanceWorkspaceView()
        case .writing:
            WritingWorkspaceView()
        case .settings:
            SettingsWorkspaceView()
        }
    }

    @ViewBuilder
    private func moreDestination(_ route: MoreRoute) -> some View {
        switch route {
        case .chess: ChessWorkspaceView(openSettings: { selection = .settings })
        case .finance: FinanceWorkspaceView()
        case .mail: MailWorkspaceView()
        case .settings: SettingsWorkspaceView()
        case .writing: WritingWorkspaceView()
        }
    }

    private func badgeCount(for destination: WorkspaceDestination) -> Int? {
        switch destination {
        case .captures:
            store.workspace.items.filter { $0.kind == .note && $0.triageStatus != .archived }.count
        case .mail:
            store.integrations.gmail.unreadCount
        default:
            nil
        }
    }

    private var connectionLabel: String {
        if store.isOnline { return "Mac available" }
        if store.hasCachedContent { return "Saved data available" }
        return store.isPaired ? "Waiting for first sync" : "Setup needed"
    }
}

private struct TabletTodayView: View {
    @Binding var selectedDay: Date
    let openTasks: () -> Void
    let openCaptures: () -> Void
    let openMail: () -> Void
    let openChess: () -> Void
    let openSettings: () -> Void

    var body: some View {
        GeometryReader { proxy in
            HStack(spacing: 0) {
                TodayView(
                    selectedDay: $selectedDay,
                    openTasks: openTasks,
                    openSettings: openSettings,
                    showsSettingsButton: false
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if proxy.size.width >= 760 {
                    Divider()
                        .overlay(WorkspaceBrand.rule)
                    TabletTodayRail(
                        selectedDay: selectedDay,
                        openCaptures: openCaptures,
                        openMail: openMail,
                        openChess: openChess
                    )
                    .frame(width: min(340, proxy.size.width * 0.36))
                }
            }
        }
        .background(WorkspaceBrand.canvas)
    }
}

private struct TabletTodayRail: View {
    @EnvironmentObject private var store: WorkspaceStore
    let selectedDay: Date
    let openCaptures: () -> Void
    let openMail: () -> Void
    let openChess: () -> Void

    private var recentCaptures: [WorkspaceItem] {
        store.workspace.items
            .filter { $0.kind == .note && $0.triageStatus != .archived }
            .sorted {
                ($0.updatedAt ?? $0.createdAt ?? "") > ($1.updatedAt ?? $1.createdAt ?? "")
            }
    }

    private var firstUnreadMessage: RemoteMail? {
        store.integrations.messages
            .filter(\.unread)
            .max { $0.receivedAt < $1.receivedAt }
    }

    private var currentLesson: ChessLesson? {
        let summary = store.chess.summary
        guard let courseId = summary.currentCourseId,
              let lessonId = summary.currentLessonId else { return nil }
        return store.chess.catalog.lessons.first {
            $0.courseId == courseId && $0.id == lessonId
        }
    }

    private var healthDay: MobileHealthDay? {
        preferredHealthDay(
            on: WorkspaceFormat.dayKey(selectedDay),
            localSnapshot: store.healthSnapshot,
            remoteSnapshot: store.healthView?.snapshot
        )
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                TabletPanel(title: "Quick capture", symbol: "square.and.pencil") {
                    CaptureComposer(compact: true)
                }

                TabletPanel(title: "Captures", symbol: "tray.full") {
                    if recentCaptures.isEmpty {
                        Text("Your capture inbox is clear.")
                            .font(.subheadline)
                            .foregroundStyle(WorkspaceBrand.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ForEach(Array(recentCaptures.prefix(3))) { item in
                            Button(action: openCaptures) {
                                Text(item.title)
                                    .font(.subheadline)
                                    .foregroundStyle(WorkspaceBrand.ink)
                                    .lineLimit(2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 3)
                            }
                            .buttonStyle(.plain)
                            if item.id != recentCaptures.prefix(3).last?.id {
                                Divider().overlay(WorkspaceBrand.rule)
                            }
                        }
                    }
                    TabletRailButton(title: "Open captures", action: openCaptures)
                }

                TabletPanel(title: "Mail", symbol: "envelope") {
                    if store.integrations.gmail.connected {
                        Text(store.integrations.gmail.unreadCount == 1
                             ? "1 unread message"
                             : "\(store.integrations.gmail.unreadCount) unread messages")
                            .font(.headline)
                            .foregroundStyle(WorkspaceBrand.ink)
                        if let firstUnreadMessage {
                            Text(firstUnreadMessage.subject.nilIfEmpty ?? "(no subject)")
                                .font(.subheadline)
                                .foregroundStyle(WorkspaceBrand.muted)
                                .lineLimit(2)
                        }
                    } else {
                        Text("Mail is not connected.")
                            .font(.subheadline)
                            .foregroundStyle(WorkspaceBrand.muted)
                    }
                    TabletRailButton(title: "Open mail", action: openMail)
                }

                TabletPanel(title: "Chess", symbol: "crown") {
                    Text(currentLesson?.title ?? "No lesson in progress")
                        .font(.headline)
                        .foregroundStyle(WorkspaceBrand.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if store.chess.summary.reviewsDue > 0 {
                        Text("\(store.chess.summary.reviewsDue) review\(store.chess.summary.reviewsDue == 1 ? "" : "s") due")
                            .font(.subheadline)
                            .foregroundStyle(WorkspaceBrand.muted)
                    }
                    TabletRailButton(title: "Open chess", action: openChess)
                }

                TabletPanel(title: "Health", symbol: "heart") {
                    if let healthDay {
                        TabletMetricLine(
                            title: "Sleep",
                            value: healthDay.sleepMinutes.map { minutesLabel(Int($0.rounded())) } ?? "—"
                        )
                        TabletMetricLine(
                            title: "Steps",
                            value: healthDay.steps.map { Int($0).formatted() } ?? "—"
                        )
                        TabletMetricLine(
                            title: "Resting heart rate",
                            value: healthDay.restingHeartRate.map { "\(Int($0.rounded())) bpm" } ?? "—"
                        )
                    } else {
                        Text("No health summary for this day.")
                            .font(.subheadline)
                            .foregroundStyle(WorkspaceBrand.muted)
                    }
                }
            }
            .padding(18)
        }
        .background(WorkspaceBrand.surface.opacity(0.45))
    }
}

private struct TabletPanel<Content: View>: View {
    let title: String
    let symbol: String
    let content: Content

    init(title: String, symbol: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.symbol = symbol
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title.uppercased(), systemImage: symbol)
                .font(.caption2.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(WorkspaceBrand.muted)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(WorkspaceBrand.canvas)
        .overlay(Rectangle().stroke(WorkspaceBrand.rule, lineWidth: 1))
    }
}

private struct TabletRailButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer()
                Image(systemName: "arrow.right")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(WorkspaceBrand.signal)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
    }
}

private struct TabletMetricLine: View {
    let title: String
    let value: String

    var body: some View {
        HStack {
            Text(title).foregroundStyle(WorkspaceBrand.muted)
            Spacer()
            Text(value).fontWeight(.semibold).foregroundStyle(WorkspaceBrand.ink)
        }
        .font(.subheadline)
    }
}

private struct CompanionSettingsToolbar: ToolbarContent {
    let openSettings: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button(action: openSettings) {
                Image(systemName: "gearshape")
            }
            .accessibilityLabel("Settings")
        }
    }
}

private struct WorkspacePrivacyCover: View {
    var body: some View {
        ZStack {
            WorkspaceBrand.canvas.ignoresSafeArea()
            VStack(spacing: 12) {
                ZStack(alignment: .bottomTrailing) {
                    WorkspaceBrandMark(size: 72)
                    Image(systemName: "lock.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(7)
                        .background(WorkspaceBrand.ink, in: Circle())
                        .overlay(Circle().stroke(WorkspaceBrand.canvas, lineWidth: 2))
                        .offset(x: 3, y: 3)
                }
                Text("Workspace")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(WorkspaceBrand.ink)
                Text("Return to the app to view your private workspace.")
                    .font(.subheadline)
                    .foregroundStyle(WorkspaceBrand.muted)
            }
            .multilineTextAlignment(.center)
            .padding()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Workspace content hidden")
    }
}

private struct WorkspaceBrandMark: View {
    let size: CGFloat

    var body: some View {
        Image("BrandMark")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private struct WorkspaceStatusBanner: View {
    @EnvironmentObject private var store: WorkspaceStore
    let openSettings: (() -> Void)?
    let errorArea: WorkspaceArea
    let requiresFullWorkspace: Bool

    init(openSettings: (() -> Void)?, errorArea: WorkspaceArea, requiresFullWorkspace: Bool = true) {
        self.openSettings = openSettings
        self.errorArea = errorArea
        self.requiresFullWorkspace = requiresFullWorkspace
    }

    var body: some View {
        let unavailable = requiresFullWorkspace ? !store.hasWorkspaceAccess : !store.isPaired
        if unavailable {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label(store.isPaired ? "Workspace access needed" : "Connect to your Mac", systemImage: "gearshape")
                        .font(.headline)
                    Text(store.isPaired
                         ? "This device is paired for Apple Health. Pair it again from Settings with a Workspace pairing file to use the companion features."
                         : "Pair this device from Settings to use the companion features.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let openSettings {
                        Button("Open Settings") { openSettings() }
                    }
                }
            }
        } else if !store.hasCachedContent, case .error(let message) = store.connectionState {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label("First sync needs attention", systemImage: "exclamationmark.triangle.fill")
                        .font(.headline)
                        .foregroundStyle(WorkspaceBrand.signal)
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let openSettings {
                        Button("Open Settings", action: openSettings)
                    }
                }
            }
        } else {
            EditorErrorSection(area: errorArea)
        }
    }
}

private struct CompanionSyncSummaryRow: View {
    @EnvironmentObject private var store: WorkspaceStore
    let openSettings: () -> Void

    var body: some View {
        if store.hasWorkspaceAccess && store.hasCachedContent {
            Button(action: openSettings) {
                HStack(spacing: 8) {
                    Image(systemName: icon)
                    Text(summary)
                    Spacer(minLength: 8)
                    if store.pendingCaptureCount > 0 {
                        Text("\(store.pendingCaptureCount) waiting")
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                }
                .font(.caption)
                .foregroundStyle(needsAttention ? WorkspaceBrand.signal : Color.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .accessibilityLabel(accessibilitySummary)
        }
    }

    private var summary: String {
        if store.connectionNeedsAttention { return "Sync needs attention" }
        if !planningIsComplete { return "Finish first sync" }
        if store.isLoading(.pairing) { return "Checking for your Mac…" }
        if let last = planningSavedAt {
            return "Updated \(last.formatted(.relative(presentation: .named)))"
        }
        return "Saved on this device"
    }

    private var icon: String {
        if store.connectionNeedsAttention { return "exclamationmark.triangle.fill" }
        if !planningIsComplete { return "desktopcomputer" }
        return store.isOnline ? "checkmark.circle" : "clock.arrow.circlepath"
    }

    private var needsAttention: Bool {
        store.connectionNeedsAttention || !planningIsComplete
    }

    private var accessibilitySummary: String {
        let waiting = store.pendingCaptureCount == 0
            ? ""
            : ", \(store.pendingCaptureCount) captures waiting to sync"
        return "\(summary)\(waiting). Open sync settings."
    }

    private var planningSavedAt: Date? {
        guard let workspace = store.cachedAt(.workspace),
              let integrations = store.cachedAt(.integrations) else { return nil }
        return min(workspace, integrations)
    }

    private var planningIsComplete: Bool {
        store.loadedAreas.contains(.workspace) && store.loadedAreas.contains(.integrations)
    }
}

private struct WorkspaceConflictBanner: View {
    @EnvironmentObject private var store: WorkspaceStore
    @State private var confirmReplace = false

    var body: some View {
        if let conflict = store.workspaceConflict {
            Section {
                Label("The Mac changed while you were editing", systemImage: "arrow.triangle.2.circlepath")
                    .font(.headline).foregroundStyle(.orange)
                Text(conflict.message).font(.subheadline).foregroundStyle(.secondary)
                Button("Apply my saved version") { confirmReplace = true }
                Button("Use the Mac version", role: .destructive) {
                    store.discardWorkspaceConflict()
                }
            } footer: {
                Text("Your attempted edit is held here until you retry it or choose the newer Mac version.")
            }
            .confirmationDialog("Replace the newer Mac version with your saved version?", isPresented: $confirmReplace, titleVisibility: .visible) {
                Button("Apply my version", role: .destructive) {
                    Task { await store.retryWorkspaceConflict() }
                }
                Button("Keep reviewing", role: .cancel) { }
            } message: {
                Text("This reapplies only your edited item to the latest Mac version and keeps its other newly loaded items.")
            }
        }
    }
}

private struct EditorErrorSection: View {
    @EnvironmentObject private var store: WorkspaceStore
    let area: WorkspaceArea

    var body: some View {
        if let message = store.areaErrors[area] {
            Section {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline).foregroundStyle(.orange)
                Button("Dismiss message") { store.clearError(area) }
                    .font(.caption.weight(.semibold))
            }
        }
    }
}

private struct MacRequiredSection: View {
    let detail: String
    var openSettings: (() -> Void)? = nil

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label("Connect to your Mac", systemImage: "desktopcomputer")
                    .font(.headline)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let openSettings {
                    Button("Open Settings", action: openSettings)
                } else {
                    NavigationLink("Open Settings", value: MoreRoute.settings)
                }
            }
        }
    }
}

private struct SettingsAttentionSection: View {
    @EnvironmentObject private var store: WorkspaceStore
    let area: WorkspaceArea
    let message: String
    let openSettings: () -> Void

    var body: some View {
        if let detail = attentionDetail {
            Section {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline).foregroundStyle(.orange)
                Text(detail).font(.caption).foregroundStyle(.secondary)
                Button("Open Settings", action: openSettings)
            }
        }
    }

    private var attentionDetail: String? {
        store.areaErrors[area] ?? (area == .integrations ? store.integrationProviderError : nil)
    }
}

// MARK: - Today

private struct MobileAgendaEntry: Identifiable {
    enum Source { case local(WorkspaceItem), google(RemoteEvent) }
    let id: String
    let title: String
    let time: String?
    let endTime: String?
    let allDay: Bool
    let subtitle: String
    let source: Source
}

private struct RemoteTaskDraft: Identifiable {
    let id = UUID()
    let task: RemoteTask?
    let day: String
    let link: IntegrationLinkRequest?
    let presetTitle: String?

    init(task: RemoteTask?, day: String, link: IntegrationLinkRequest?, presetTitle: String? = nil) {
        self.task = task
        self.day = day
        self.link = link
        self.presetTitle = presetTitle
    }
}

private struct RemoteEventDraft: Identifiable {
    let id = UUID()
    let event: RemoteEvent?
    let day: String
    let presetTitle: String?
    let presetLocation: String?
    let link: IntegrationLinkRequest?
}

private struct WorkspaceItemDraft: Identifiable {
    let id = UUID()
    let item: WorkspaceItem
    let openingState: WorkspaceState
    let isNew: Bool
}

private struct ClimbingEditorDraft<Value: Identifiable>: Identifiable {
    let id = UUID()
    let value: Value
    let openingState: ClimbingState
    let isNew: Bool
}

struct TodayView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Binding var selectedDay: Date
    let openTasks: () -> Void
    let openSettings: () -> Void
    let showsSettingsButton: Bool

    @State private var itemDraft: WorkspaceItemDraft?
    @State private var taskDraft: RemoteTaskDraft?
    @State private var eventDraft: RemoteEventDraft?
    @State private var taskToComplete: RemoteTask?

    init(
        selectedDay: Binding<Date>,
        openTasks: @escaping () -> Void,
        openSettings: @escaping () -> Void,
        showsSettingsButton: Bool = true
    ) {
        _selectedDay = selectedDay
        self.openTasks = openTasks
        self.openSettings = openSettings
        self.showsSettingsButton = showsSettingsButton
    }

    private var day: String { WorkspaceFormat.dayKey(selectedDay) }
    private var today: String { WorkspaceFormat.dayKey() }
    private var priorities: [WorkspaceItem] {
        store.workspace.items.filter { $0.kind == .priority && $0.date == day }
    }
    private var tasks: [RemoteTask] {
        return store.integrations.tasks
            .filter { task in
                guard task.area == .personal, let attentionDate = taskAttentionDate(task) else { return false }
                return attentionDate == day || (day == today && attentionDate < day)
            }
            .sorted {
                let leftDate = taskAttentionDate($0) ?? day
                let rightDate = taskAttentionDate($1) ?? day
                if leftDate != rightDate { return leftDate < rightDate }
                let leftTime = $0.dueTime ?? "99:99"
                let rightTime = $1.dueTime ?? "99:99"
                if leftTime != rightTime { return leftTime < rightTime }
                return $0.priority > $1.priority
            }
    }
    private var agenda: [MobileAgendaEntry] {
        let local = store.workspace.items.compactMap { item -> MobileAgendaEntry? in
            guard item.kind == .plan, item.date == day else { return nil }
            return MobileAgendaEntry(
                id: "local:\(item.id)", title: item.title, time: item.time, endTime: item.endTime,
                allDay: false, subtitle: item.area == .personal ? "Personal · Local plan" : "Independent work · Local plan",
                source: .local(item)
            )
        }
        let remote: [MobileAgendaEntry] = store.integrations.events.compactMap { event in
            guard eventOccurs(event, on: day) else { return nil }
            let subtitle = [event.location, event.sourceName, event.recurring ? "This occurrence" : nil]
                .compactMap { value in value?.isEmpty == false ? value : nil }
                .joined(separator: " · ")
            return MobileAgendaEntry(
                id: "google:\(event.sourceId):\(event.id)", title: event.title,
                time: event.startDate < day ? nil : event.startTime, endTime: event.endDate > day ? nil : event.endTime,
                allDay: event.allDay, subtitle: subtitle, source: .google(event)
            )
        }
        return (local + remote).sorted {
            if $0.allDay != $1.allDay { return $0.allDay }
            return ($0.time ?? "99:99", $0.title) < ($1.time ?? "99:99", $1.title)
        }
    }
    private var healthDay: MobileHealthDay? {
        preferredHealthDay(
            on: day,
            localSnapshot: store.healthSnapshot,
            remoteSnapshot: store.healthView?.snapshot
        )
    }
    var body: some View {
        List {
            WorkspaceStatusBanner(openSettings: openSettings, errorArea: .workspace)
            SettingsAttentionSection(
                area: .health,
                message: store.managesAppleHealth ? "Apple Health needs attention." : "Health summary needs attention.",
                openSettings: openSettings
            )
            Section {
                WeekDayPicker(selection: $selectedDay)
            }
            CompanionSyncSummaryRow(openSettings: openSettings)

            if store.hasWorkspaceAccess && !hasPlanningSnapshot && !store.connectionNeedsAttention {
                Section {
                    HStack(spacing: 10) {
                        if store.isLoading(.workspace) || store.isLoading(.integrations) { ProgressView() }
                        EmptyRow(
                            icon: store.isLoading(.workspace) || store.isLoading(.integrations) ? "arrow.clockwise" : "desktopcomputer",
                            title: store.isLoading(.workspace) || store.isLoading(.integrations) ? "Loading your day" : "First sync needed",
                            detail: store.isLoading(.workspace) || store.isLoading(.integrations)
                                ? "Workspace is loading the latest planning snapshot."
                                : "Sync with your Mac once to bring your daily plan to this device."
                        )
                    }
                }
            }

            if store.hasWorkspaceAccess && hasPlanningSnapshot {
                SettingsAttentionSection(area: .integrations, message: "Calendar or Todoist items need attention.", openSettings: openSettings)
                WorkspaceConflictBanner()

                Section("Priorities") {
                    if priorities.isEmpty {
                        Text("No priorities set.").foregroundStyle(.secondary)
                    } else {
                        ForEach(priorities) { item in
                            HStack(spacing: 12) {
                                Button {
                                    guard store.workspace.items.contains(where: {
                                        $0.id == item.id && $0.kind == .priority && $0.date == day
                                    }) else {
                                        store.reportStaleRow("Workspace item", area: .workspace)
                                        return
                                    }
                                    Task { await store.toggleWorkspaceItem(id: item.id) }
                                } label: {
                                    Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                                        .font(.title3)
                                        .foregroundStyle(item.done ? Color.green : Color.secondary)
                                }
                                .buttonStyle(.plain)
                                Button { presentExistingItem(id: item.id) } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(item.title).strikethrough(item.done)
                                        Text(item.area == .personal ? "Personal" : "Independent work")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }

                Section("Schedule") {
                    if agenda.isEmpty {
                        Text("Nothing scheduled.").foregroundStyle(.secondary)
                    } else {
                        ForEach(agenda) { entry in
                            Button { openAgenda(entry) } label: {
                                AgendaRow(entry: entry)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if store.integrations.todoist.connected {
                    Section("Todoist") {
                        if tasks.isEmpty {
                            Text("No tasks due.").foregroundStyle(.secondary)
                        } else {
                            ForEach(Array(tasks.prefix(5))) { task in
                                HStack(spacing: 12) {
                                    Button { taskToComplete = task } label: {
                                        Image(systemName: "circle")
                                            .font(.title3)
                                            .foregroundStyle(.red)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Complete \(task.title)")
                                    Button { taskDraft = RemoteTaskDraft(task: task, day: day, link: nil) } label: {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(task.title).foregroundStyle(.primary)
                                            Text(taskMetadata(task, relativeTo: day))
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                }
                                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                    Button { taskToComplete = task } label: { Label("Complete", systemImage: "checkmark") }
                                        .tint(.green)
                                }
                            }
                        }
                        Button(action: openTasks) {
                            Label("View all tasks", systemImage: "arrow.right")
                        }
                    }
                }
            }

            Section("Health summary") {
                if let healthDay {
                    HealthMetricRow(icon: "bed.double.fill", color: .indigo, title: "Sleep", value: healthDay.sleepMinutes.map { minutesLabel(Int($0.rounded())) } ?? "—")
                    HealthMetricRow(icon: "figure.walk", color: .green, title: "Steps", value: healthDay.steps.map { Int($0).formatted() } ?? "—")
                    HealthMetricRow(icon: "heart.fill", color: .pink, title: "Resting heart rate", value: healthDay.restingHeartRate.map { "\(Int($0.rounded())) bpm" } ?? "—")
                } else {
                    Text("No health data for this day.").foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(day == today ? "Today" : shortDay(day))
        .scrollContentBackground(.hidden)
        .background(WorkspaceBrand.canvas)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button("Priority", systemImage: "sparkles") { presentNewItem(.new(kind: .priority, area: defaultArea, date: day)) }
                    Button("Plan", systemImage: "calendar.badge.plus") {
                        var plan = WorkspaceItem.new(kind: .plan, area: defaultArea, date: day)
                        plan.time = "09:00"
                        presentNewItem(plan)
                    }
                    if store.integrations.todoist.connected {
                        Button("Todoist task", systemImage: "checkmark.circle") { taskDraft = RemoteTaskDraft(task: nil, day: day, link: nil) }
                    }
                    if store.integrations.google.connected {
                        Button("Calendar event", systemImage: "calendar") { eventDraft = RemoteEventDraft(event: nil, day: day, presetTitle: nil, presetLocation: nil, link: nil) }
                    }
                } label: { Image(systemName: "plus") }
                .disabled(!store.hasWorkspaceAccess)
                .accessibilityLabel("Add to today")

                if showsSettingsButton {
                    Button(action: openSettings) {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
        }
        .task(id: day) {
            guard store.hasWorkspaceAccess else { return }
            await store.refreshIntegrationsIfNeeded(on: day)
        }
        .sheet(item: $itemDraft) { draft in
            WorkspaceItemEditor(draft: draft)
        }
        .sheet(item: $taskDraft) { draft in
            TodoistTaskEditor(draft: draft)
        }
        .sheet(item: $eventDraft) { draft in
            CalendarEventEditor(draft: draft)
        }
        .confirmationDialog(
            taskToComplete.map { "Complete “\($0.title)” in Todoist?" } ?? "Complete this task?",
            isPresented: Binding(get: { taskToComplete != nil }, set: { if !$0 { taskToComplete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Complete in Todoist") {
                guard let task = taskToComplete else { return }
                taskToComplete = nil
                Task {
                    await store.mutateIntegration(IntegrationMutation(
                        provider: .todoist, action: .complete, id: task.id, version: task.version,
                        anchorDate: day
                    ))
                }
            }
            Button("Cancel", role: .cancel) { taskToComplete = nil }
        } message: {
            Text("This writes to the connected Personal project. A recurring task advances to its next occurrence.")
        }
    }

    private var defaultArea: LifeArea { .personal }
    private var hasPlanningSnapshot: Bool {
        store.loadedAreas.contains(.workspace) && store.loadedAreas.contains(.integrations)
    }

    private func taskAttentionDate(_ task: RemoteTask) -> String? {
        [task.dueDate, task.deadline].compactMap { $0 }.min()
    }

    private func presentExistingItem(id: String) {
        let openingState = store.workspace
        guard let item = openingState.items.first(where: { $0.id == id }) else {
            store.reportStaleRow("Workspace item", area: .workspace)
            return
        }
        itemDraft = WorkspaceItemDraft(
            item: item,
            openingState: openingState,
            isNew: false
        )
    }

    private func presentNewItem(_ item: WorkspaceItem) {
        itemDraft = WorkspaceItemDraft(item: item, openingState: store.workspace, isNew: true)
    }

    private func openAgenda(_ entry: MobileAgendaEntry) {
        switch entry.source {
        case .local(let item): presentExistingItem(id: item.id)
        case .google(let event): eventDraft = RemoteEventDraft(event: event, day: day, presetTitle: nil, presetLocation: nil, link: nil)
        }
    }
}

private struct AgendaRow: View {
    let entry: MobileAgendaEntry
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.allDay ? "All day" : entry.time.map(clockLabel) ?? "Continues")
                    .font(.subheadline.weight(.semibold))
                if let end = entry.endTime, !entry.allDay {
                    Text(clockLabel(end)).font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(width: 74, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title).font(.body.weight(.medium))
                Text(entry.subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            switch entry.source {
            case .local: Image(systemName: UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone").foregroundStyle(.secondary)
            case .google: Image(systemName: "calendar").foregroundStyle(.blue)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct EmptyRow: View {
    let icon: String
    let title: String
    let detail: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(WorkspaceBrand.signal).frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct WeekDayPicker: View {
    @Binding var selection: Date
    private var days: [Date] {
        let calendar = Calendar.current
        let start = calendar.dateInterval(of: .weekOfYear, for: selection)?.start ?? selection
        return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Button { shift(-7) } label: { Image(systemName: "chevron.left") }
                    .frame(width: 44, height: 44)
                    .accessibilityLabel("Previous week")
                Spacer()
                Text(selection.formatted(.dateTime.month(.wide).year()))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(WorkspaceBrand.ink)
                Spacer()
                Button { shift(7) } label: { Image(systemName: "chevron.right") }
                    .frame(width: 44, height: 44)
                    .accessibilityLabel("Next week")
            }
            HStack(spacing: 4) {
                ForEach(days, id: \.self) { date in
                    let selected = Calendar.current.isDate(date, inSameDayAs: selection)
                    Button { selection = date } label: {
                        VStack(spacing: 5) {
                            Text(date.formatted(.dateTime.weekday(.narrow))).font(.caption2)
                            Text(date.formatted(.dateTime.day())).font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 44)
                        .background(selected ? WorkspaceBrand.ink : Color.clear)
                        .foregroundStyle(selected ? WorkspaceBrand.canvas : WorkspaceBrand.ink)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(date.formatted(date: .complete, time: .omitted))
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            if !Calendar.current.isDateInToday(selection) {
                Button("Return to today") { selection = Date() }
                    .font(.caption.weight(.semibold))
                    .frame(minHeight: 44)
            }
        }
        .padding(14)
        .background(WorkspaceBrand.surface)
        .overlay(Rectangle().stroke(WorkspaceBrand.rule, lineWidth: 1))
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    private func shift(_ days: Int) {
        selection = Calendar.current.date(byAdding: .day, value: days, to: selection) ?? selection
    }
}

// MARK: - Capture and tasks

struct CaptureView: View {
    let openSettings: () -> Void

    var body: some View {
        List {
            WorkspaceStatusBanner(openSettings: openSettings, errorArea: .workspace)

            Section {
                CaptureComposer()
            }
            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
        .navigationTitle("Capture")
        .toolbar {
            CompanionSettingsToolbar(openSettings: openSettings)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollContentBackground(.hidden)
        .background(WorkspaceBrand.canvas)
    }
}

private struct CaptureComposer: View {
    @EnvironmentObject private var store: WorkspaceStore
    let compact: Bool

    @State private var saveMessage: String?
    @FocusState private var captureFocused: Bool

    init(compact: Bool = false) {
        self.compact = compact
    }

    private var trimmedCapture: String {
        store.captureDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var captureBinding: Binding<String> {
        Binding(get: { store.captureDraft }, set: { store.updateCaptureDraft($0) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 14) {
            TextField("What’s on your mind?", text: captureBinding, axis: .vertical)
                .font(compact ? .body : .title3)
                .lineLimit(compact ? 4...7 : 7...12)
                .frame(minHeight: compact ? 92 : 180, alignment: .topLeading)
                .focused($captureFocused)
                .disabled(!store.hasWorkspaceAccess)
                .onChange(of: store.captureDraft) { _, value in
                    if !value.isEmpty { saveMessage = nil }
                }

            Divider().overlay(WorkspaceBrand.rule)

            HStack {
                if let captureStatus {
                    Text(captureStatus)
                        .font(.caption)
                        .foregroundStyle(WorkspaceBrand.signal)
                        .lineLimit(2)
                }
                Spacer()
                Button(action: saveCapture) {
                    Label(store.isLoading(.workspace) ? "Saving" : "Save", systemImage: "arrow.right")
                        .font((compact ? Font.caption : Font.body).weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, compact ? 12 : 16)
                        .frame(minHeight: compact ? 38 : 46)
                        .background(
                            trimmedCapture.isEmpty
                                ? Color.secondary.opacity(0.45)
                                : WorkspaceBrand.signal,
                            in: Rectangle()
                        )
                }
                .buttonStyle(.plain)
                .disabled(trimmedCapture.isEmpty || !store.hasWorkspaceAccess)
                .accessibilityLabel("Save to Workspace Captures")
            }
        }
        .padding(compact ? 12 : 18)
        .background(WorkspaceBrand.surface)
        .overlay(Rectangle().stroke(WorkspaceBrand.rule, lineWidth: 1))
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { captureFocused = false }
                    .fontWeight(.semibold)
            }
        }
        .onDisappear { captureFocused = false }
    }

    private var captureStatus: String? {
        if let saveMessage { return saveMessage }
        switch store.pendingCaptureCount {
        case 0: return nil
        case 1: return "1 capture waiting for your Mac"
        default: return "\(store.pendingCaptureCount) captures waiting for your Mac"
        }
    }

    private func saveCapture() {
        let submittedCapture = store.captureDraft
        let submittedText = submittedCapture.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !submittedText.isEmpty else { return }
        captureFocused = false
        Task {
            switch await store.submitCapture(submittedText) {
            case .delivered:
                saveMessage = "Saved to Workspace Captures"
            case .queued:
                saveMessage = "Saved on this device"
            case nil:
                break
            }
        }
    }
}

private struct TabletCapturesView: View {
    @EnvironmentObject private var store: WorkspaceStore
    let openSettings: () -> Void

    @State private var itemDraft: WorkspaceItemDraft?

    private var captures: [WorkspaceItem] {
        store.workspace.items
            .filter { $0.kind == .note && $0.triageStatus != .archived }
            .sorted {
                ($0.updatedAt ?? $0.createdAt ?? "") > ($1.updatedAt ?? $1.createdAt ?? "")
            }
    }

    var body: some View {
        List {
            WorkspaceStatusBanner(openSettings: openSettings, errorArea: .workspace)
            WorkspaceConflictBanner()

            Section("Add a capture") {
                CaptureComposer(compact: true)
                    .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }

            Section {
                if captures.isEmpty {
                    EmptyRow(
                        icon: "tray",
                        title: "Your capture inbox is clear",
                        detail: "Loose thoughts and reminders stay here until you review or archive them."
                    )
                } else {
                    ForEach(captures) { item in
                        Button { present(item.id) } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: item.triageStatus == .new ? "circle.fill" : "circle")
                                    .font(.caption2)
                                    .foregroundStyle(item.triageStatus == .new ? WorkspaceBrand.signal : WorkspaceBrand.rule)
                                    .padding(.top, 6)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(item.title)
                                        .foregroundStyle(WorkspaceBrand.ink)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    Text(captureMetadata(item))
                                        .font(.caption)
                                        .foregroundStyle(WorkspaceBrand.muted)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button {
                                archive(item.id)
                            } label: {
                                Label("Archive", systemImage: "archivebox")
                            }
                            .tint(WorkspaceBrand.signal)
                        }
                    }
                }
            } header: {
                HStack {
                    Text("Inbox")
                    Spacer()
                    if !captures.isEmpty {
                        Text(captures.count.formatted())
                    }
                }
            } footer: {
                Text("Open a capture to edit it. Swipe left to archive it.")
            }
        }
        .navigationTitle("Captures")
        .scrollDismissesKeyboard(.interactively)
        .scrollContentBackground(.hidden)
        .background(WorkspaceBrand.canvas)
        .task {
            guard store.hasWorkspaceAccess else { return }
            await store.load(.workspace)
        }
        .refreshable {
            guard store.hasWorkspaceAccess else { return }
            await store.load(.workspace, force: true)
        }
        .sheet(item: $itemDraft) { WorkspaceItemEditor(draft: $0) }
    }

    private func present(_ id: String) {
        let openingState = store.workspace
        guard let item = openingState.items.first(where: { $0.id == id }) else {
            store.reportStaleRow("Capture", area: .workspace)
            return
        }
        itemDraft = WorkspaceItemDraft(item: item, openingState: openingState, isNew: false)
    }

    private func archive(_ id: String) {
        let openingState = store.workspace
        guard var item = openingState.items.first(where: { $0.id == id }) else {
            store.reportStaleRow("Capture", area: .workspace)
            return
        }
        item.triageStatus = .archived
        Task { await store.upsertWorkspaceItem(item, openingState: openingState) }
    }

    private func captureMetadata(_ item: WorkspaceItem) -> String {
        let area = item.area == .personal ? "Personal" : "Independent work"
        let status = item.triageStatus == .new ? "New" : "Reviewed"
        let date = (item.updatedAt ?? item.createdAt).map(displayTimestamp)
        return [area, status, date].compactMap { $0 }.joined(separator: " · ")
    }
}

struct TasksView: View {
    @EnvironmentObject private var store: WorkspaceStore
    let openSettings: () -> Void

    @State private var search = ""
    @State private var taskDraft: RemoteTaskDraft?
    @State private var taskToComplete: RemoteTask?

    private var today: String { WorkspaceFormat.dayKey() }
    private var personalTasks: [RemoteTask] {
        store.integrations.tasks.filter { task in
            task.area == .personal && (
                search.isEmpty
                    || task.title.localizedCaseInsensitiveContains(search)
                    || task.sourceName.localizedCaseInsensitiveContains(search)
            )
        }
    }
    private var overdueTasks: [RemoteTask] {
        sortedTasks(personalTasks.filter { taskAttentionDate($0).map { $0 < today } == true })
    }
    private var todayTasks: [RemoteTask] {
        sortedTasks(personalTasks.filter { taskAttentionDate($0) == today })
    }
    private var upcomingTasks: [RemoteTask] {
        sortedTasks(personalTasks.filter { taskAttentionDate($0).map { $0 > today } == true })
    }
    private var unscheduledTasks: [RemoteTask] {
        sortedTasks(personalTasks.filter { $0.dueDate == nil && $0.deadline == nil })
    }

    var body: some View {
        List {
            WorkspaceStatusBanner(openSettings: openSettings, errorArea: .integrations)
            SettingsAttentionSection(area: .integrations, message: "Todoist needs attention.", openSettings: openSettings)

            if store.hasWorkspaceAccess {
                if !store.loadedAreas.contains(.integrations), store.isLoading(.integrations) {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Loading Personal tasks…").foregroundStyle(.secondary)
                        }
                    }
                } else if !store.loadedAreas.contains(.integrations) && !store.connectionNeedsAttention {
                    Section {
                        EmptyRow(
                            icon: "desktopcomputer",
                            title: "First sync needed",
                            detail: "Sync with your Mac once to bring your Personal Todoist tasks to this device."
                        )
                    }
                } else if store.loadedAreas.contains(.integrations) && !store.integrations.todoist.connected {
                    Section {
                        EmptyRow(
                            icon: "checkmark.circle",
                            title: "Todoist is not connected",
                            detail: "Connect the Personal project from Workspace on your Mac, then refresh from Settings."
                        )
                        Button("Open Settings", action: openSettings)
                    }
                } else if personalTasks.isEmpty {
                    Section {
                        EmptyRow(
                            icon: search.isEmpty ? "checkmark.seal.fill" : "magnifyingglass",
                            title: search.isEmpty ? "Personal tasks are clear" : "No matching tasks",
                            detail: search.isEmpty
                                ? "New Todoist tasks from your Personal project will appear here."
                                : "Try another task or project name."
                        )
                    }
                } else {
                    taskSection("Overdue", tasks: overdueTasks)
                    taskSection("Today", tasks: todayTasks)
                    taskSection("Upcoming", tasks: upcomingTasks)
                    taskSection("No date", tasks: unscheduledTasks)
                }

                if store.integrations.todoist.connected {
                    Section {
                        Button {
                            taskDraft = RemoteTaskDraft(task: nil, day: today, link: nil)
                        } label: {
                            Label("Add Todoist task", systemImage: "plus")
                        }
                    } footer: {
                        Text(tasksFreshnessFooter)
                    }
                }
            }
        }
        .navigationTitle("Tasks")
        .toolbar { CompanionSettingsToolbar(openSettings: openSettings) }
        .searchable(text: $search, prompt: "Search Personal tasks")
        .task {
            guard store.hasWorkspaceAccess else { return }
            await store.load(.integrations)
        }
        .sheet(item: $taskDraft) { TodoistTaskEditor(draft: $0) }
        .confirmationDialog(
            taskToComplete.map { "Complete “\($0.title)” in Todoist?" } ?? "Complete this task?",
            isPresented: Binding(get: { taskToComplete != nil }, set: { if !$0 { taskToComplete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Complete in Todoist") {
                guard let task = taskToComplete else { return }
                taskToComplete = nil
                Task {
                    await store.mutateIntegration(IntegrationMutation(
                        provider: .todoist,
                        action: .complete,
                        id: task.id,
                        version: task.version,
                        anchorDate: today
                    ))
                }
            }
            Button("Cancel", role: .cancel) { taskToComplete = nil }
        } message: {
            Text("This writes to the connected Personal project. A recurring task advances to its next occurrence.")
        }
    }

    @ViewBuilder
    private func taskSection(_ title: String, tasks: [RemoteTask]) -> some View {
        if !tasks.isEmpty {
            Section(title) {
                ForEach(tasks) { task in
                    HStack(alignment: .top, spacing: 12) {
                        Button { taskToComplete = task } label: {
                            Image(systemName: "circle")
                                .font(.title3)
                                .foregroundStyle(.red)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Complete \(task.title)")
                        Button {
                            taskDraft = RemoteTaskDraft(task: task, day: today, link: nil)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(task.title)
                                    .foregroundStyle(.primary)
                                Text(taskMetadata(task, relativeTo: today))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button {
                            taskToComplete = task
                        } label: {
                            Label("Complete", systemImage: "checkmark")
                        }
                        .tint(.green)
                    }
                }
            }
        }
    }

    private func sortedTasks(_ tasks: [RemoteTask]) -> [RemoteTask] {
        tasks.sorted { left, right in
            let leftDate = taskAttentionDate(left) ?? "9999-12-31"
            let rightDate = taskAttentionDate(right) ?? "9999-12-31"
            if leftDate != rightDate { return leftDate < rightDate }
            let leftTime = left.dueTime ?? "99:99"
            let rightTime = right.dueTime ?? "99:99"
            if leftTime != rightTime { return leftTime < rightTime }
            if left.priority != right.priority { return left.priority > right.priority }
            return left.title.localizedCaseInsensitiveCompare(right.title) == .orderedAscending
        }
    }

    private func taskAttentionDate(_ task: RemoteTask) -> String? {
        [task.dueDate, task.deadline].compactMap { $0 }.min()
    }

    private var tasksFreshnessFooter: String {
        if let value = store.integrations.todoist.lastSynced {
            return "Personal project · Last synced \(displayTimestamp(value))."
        }
        return "Tasks stay in Todoist’s Personal project and sync through your paired Mac."
    }
}

// MARK: - Daily item editor

private struct WorkspaceItemEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let original: WorkspaceItem
    @State private var value: WorkspaceItem
    @State private var openingState: WorkspaceState
    @State private var wasNew: Bool
    @State private var deleteRequested = false

    init(draft: WorkspaceItemDraft) {
        original = draft.item
        _value = State(initialValue: draft.item)
        _openingState = State(initialValue: draft.openingState)
        _wasNew = State(initialValue: draft.isNew)
    }

    private var isNew: Bool { wasNew }
    private var dirty: Bool { value != original }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .workspace)
                Section {
                    Picker("Kind", selection: $value.kind) {
                        Text("Priority").tag(WorkspaceItemKind.priority)
                        Text("Plan").tag(WorkspaceItemKind.plan)
                        Text("Capture").tag(WorkspaceItemKind.note)
                    }
                    .onChange(of: value.kind) { _, kind in normalize(kind) }
                    TextField(value.kind == .note ? "What is on your mind?" : "What is the plan?", text: $value.title, axis: .vertical)
                        .lineLimit(2...8)
                    Picker("Life area", selection: $value.area) {
                        Text("Personal").tag(LifeArea.personal)
                        Text("Independent work").tag(LifeArea.independent)
                    }
                }
                if value.kind != .note {
                    Section("When") {
                        DayField("Date", value: Binding(get: { value.date ?? WorkspaceFormat.dayKey() }, set: { value.date = $0 }))
                        if value.kind == .plan {
                            TimeField("Starts", value: Binding(get: { value.time ?? "09:00" }, set: { value.time = $0 }))
                            Toggle("Add an end time", isOn: Binding(
                                get: { value.endTime != nil },
                                set: { value.endTime = $0 ? nextHour(value.time ?? "09:00") : nil }
                            ))
                            if value.endTime != nil {
                                TimeField("Ends", value: Binding(get: { value.endTime ?? "10:00" }, set: { value.endTime = $0 }))
                            }
                        }
                    }
                }
                if !isNew {
                    Section {
                        Button("Delete from Workspace", role: .destructive) { deleteRequested = true }
                    }
                }
            }
            .navigationTitle(isNew ? "Add to Workspace" : "Edit item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(value.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(dirty)
            .confirmationDialog("Delete this item?", isPresented: $deleteRequested, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task {
                        await store.removeWorkspaceItem(id: value.id, openingState: openingState)
                        if !store.workspace.items.contains(where: { $0.id == value.id }) { dismiss() }
                    }
                }
                Button("Cancel", role: .cancel) { }
            } message: { Text("This removes it from your Mac Workspace.") }
        }
    }

    private func normalize(_ kind: WorkspaceItemKind) {
        if kind == .note {
            value.date = nil; value.time = nil; value.endTime = nil; value.done = false
        } else {
            value.date = value.date ?? WorkspaceFormat.dayKey()
            if kind == .plan { value.time = value.time ?? "09:00" }
            else { value.time = nil; value.endTime = nil }
        }
    }

    private func save() {
        value.title = value.title.trimmingCharacters(in: .whitespacesAndNewlines)
        normalize(value.kind)
        let expected = value
        Task {
            if await store.upsertWorkspaceItem(expected, openingState: openingState) { dismiss() }
        }
    }
}

// MARK: - Connected item editors

private struct TodoistTaskEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let draft: RemoteTaskDraft
    @State private var title: String
    @State private var dueDate: String
    @State private var hasDueDate: Bool
    @State private var sourceId: String
    @State private var confirmSave = false
    @State private var confirmDelete = false
    @State private var requestId: String

    init(draft: RemoteTaskDraft) {
        self.draft = draft
        _title = State(initialValue: draft.task?.title ?? draft.presetTitle ?? "")
        _dueDate = State(initialValue: draft.task?.dueDate ?? draft.day)
        _hasDueDate = State(initialValue: draft.task?.dueDate != nil || draft.task == nil)
        _sourceId = State(initialValue: draft.task?.sourceId ?? "")
        _requestId = State(initialValue: UUID().uuidString.lowercased())
    }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .integrations)
                Section {
                    TextField("Task", text: $title, axis: .vertical).lineLimit(2...6)
                    if draft.task == nil {
                        Picker("Project", selection: $sourceId) {
                            ForEach(availableSources) { source in Text(source.name).tag(source.id) }
                        }
                    }
                    if draft.task?.recurring == true || draft.task?.dueTime != nil {
                        LabeledContent("Schedule", value: taskMetadata(draft.task!, relativeTo: draft.day))
                    } else {
                        Toggle("Due date", isOn: $hasDueDate)
                        if hasDueDate {
                            DayField("Date", value: $dueDate)
                        }
                    }
                } footer: {
                    if draft.task?.recurring == true || draft.task?.dueTime != nil {
                        Text("This task keeps its recurring schedule or time in Todoist. Only its title can be changed here.")
                    } else {
                        Text("Changes write to your connected Personal project after confirmation.")
                    }
                }
                if draft.task != nil {
                    Section {
                        Button("Delete from Todoist", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .navigationTitle(draft.task == nil ? "New Todoist task" : "Edit Todoist task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Review") { confirmSave = true }
                        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (draft.task == nil && effectiveSourceId.isEmpty))
                }
            }
            .confirmationDialog("Save this task to Todoist?", isPresented: $confirmSave, titleVisibility: .visible) {
                Button("Save to Todoist") { perform(draft.task == nil ? .create : .update) }
                Button("Keep editing", role: .cancel) { }
            } message: { Text("This changes the connected Personal project. Your text stays in this editor if Todoist rejects the request.") }
            .confirmationDialog("Delete this task from Todoist?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete from Todoist", role: .destructive) { perform(.delete) }
                Button("Keep task", role: .cancel) { }
            } message: { Text("Todoist also deletes completed subtasks that belong to this task.") }
        }
    }

    private var availableSources: [IntegrationSource] {
        store.integrations.todoist.sources.filter { !$0.blocked }
    }
    private var effectiveSourceId: String {
        if !sourceId.isEmpty { return sourceId }
        return availableSources.first(where: { $0.name.caseInsensitiveCompare("Personal") == .orderedSame })?.id ?? availableSources.first?.id ?? ""
    }

    private func perform(_ action: IntegrationAction) {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let submittedDate = action == .delete || draft.task?.recurring == true || draft.task?.dueTime != nil ? nil : (hasDueDate ? dueDate : nil)
        var mutation = IntegrationMutation(
            provider: .todoist, action: action, id: draft.task?.id, version: draft.task?.version,
            requestId: requestId, sourceId: action == .create ? effectiveSourceId : nil, anchorDate: draft.day,
            title: action == .delete ? nil : trimmedTitle,
            date: submittedDate,
            link: action == .create ? draft.link : nil
        )
        mutation.encodesNilDate = action == .update && draft.task?.recurring != true && draft.task?.dueTime == nil && !hasDueDate
        Task {
            if await store.mutateIntegration(mutation) { dismiss() }
        }
    }
}

private struct CalendarEventEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let draft: RemoteEventDraft
    @State private var title: String
    @State private var startDate: String
    @State private var endDate: String
    @State private var startTime: String
    @State private var endTime: String
    @State private var allDay: Bool
    @State private var location: String
    @State private var confirmSave = false
    @State private var confirmDelete = false
    @State private var requestId: String

    init(draft: RemoteEventDraft) {
        self.draft = draft
        let event = draft.event
        _title = State(initialValue: event?.title ?? draft.presetTitle ?? "")
        _startDate = State(initialValue: event?.startDate ?? draft.day)
        _endDate = State(initialValue: event?.endDate ?? draft.day)
        _startTime = State(initialValue: event?.startTime ?? "09:00")
        _endTime = State(initialValue: event?.endTime ?? "10:00")
        _allDay = State(initialValue: event?.allDay ?? false)
        _location = State(initialValue: event?.location ?? draft.presetLocation ?? "")
        _requestId = State(initialValue: UUID().uuidString.lowercased())
    }

    var body: some View {
        NavigationStack {
            if draft.event?.editable == false {
                ContentUnavailableView {
                    Label("Edit in Google Calendar", systemImage: "calendar.badge.exclamationmark")
                } description: {
                    Text("This event has guests, another organizer, or a special Calendar format.")
                } actions: {
                    if let text = draft.event?.url, let url = URL(string: text) {
                        Link("Open Google Calendar", destination: url)
                    }
                }
                .navigationTitle("Calendar event")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            } else {
                Form {
                    EditorErrorSection(area: .integrations)
                    Section {
                        TextField("Event", text: $title, axis: .vertical).lineLimit(2...6)
                        Toggle("All-day event", isOn: $allDay)
                        DayField("Starts", value: $startDate)
                        DayField(allDay ? "Ends before" : "Ends on", value: $endDate)
                        if !allDay {
                            TimeField("Start time", value: $startTime)
                            TimeField("End time", value: $endTime)
                        }
                        TextField("Location (optional)", text: $location)
                    } footer: {
                        Text(allDay ? "The end date is exclusive. A one-day event ends before the following date." : "Times use \(TimeZone.current.identifier). Events created here have no guests.")
                    }
                    if draft.event != nil {
                        Section { Button("Delete from Calendar", role: .destructive) { confirmDelete = true } }
                    }
                }
                .navigationTitle(draft.event == nil ? "New Calendar event" : "Edit Calendar event")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Review") { confirmSave = true }
                            .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .confirmationDialog("Save this event to Google Calendar?", isPresented: $confirmSave, titleVisibility: .visible) {
                    Button("Save to Calendar") { perform(draft.event == nil ? .create : .update) }
                    Button("Keep editing", role: .cancel) { }
                } message: { Text("This writes to your personal Google Calendar. Your draft stays open if Calendar rejects it.") }
                .confirmationDialog("Delete this event from Google Calendar?", isPresented: $confirmDelete, titleVisibility: .visible) {
                    Button("Delete from Calendar", role: .destructive) { perform(.delete) }
                    Button("Keep event", role: .cancel) { }
                }
            }
        }
    }

    private func perform(_ action: IntegrationAction) {
        let event = draft.event
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let mutation = IntegrationMutation(
            provider: .google, action: action, id: event?.id, version: event?.version,
            requestId: requestId, anchorDate: draft.day, title: action == .delete ? nil : trimmedTitle,
            date: action == .delete ? nil : startDate, endDate: action == .delete ? nil : normalizedEndDate,
            time: action == .delete || allDay ? nil : startTime, endTime: action == .delete || allDay ? nil : endTime,
            allDay: action == .delete ? nil : allDay, location: action == .delete ? nil : location,
            link: action == .create ? draft.link : nil
        )
        Task {
            if await store.mutateIntegration(mutation) { dismiss() }
        }
    }

    private var normalizedEndDate: String {
        if allDay && endDate <= startDate { return shiftDay(startDate, by: 1) }
        return endDate < startDate ? startDate : endDate
    }
}

// MARK: - Shared form controls and formatting

private struct DayField: View {
    let title: String
    @Binding var value: String

    init(_ title: String, value: Binding<String>) {
        self.title = title
        _value = value
    }

    var body: some View {
        DatePicker(title, selection: Binding(
            get: { dateFromDay(value) ?? Date() },
            set: { value = WorkspaceFormat.dayKey($0) }
        ), displayedComponents: .date)
    }
}

private struct TimeField: View {
    let title: String
    @Binding var value: String

    init(_ title: String, value: Binding<String>) {
        self.title = title
        _value = value
    }

    var body: some View {
        DatePicker(title, selection: Binding(
            get: { dateFromTime(value) ?? Date() },
            set: { value = timeKey($0) }
        ), displayedComponents: .hourAndMinute)
    }
}

private extension String {
    var nilIfEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

private func dateFromDay(_ value: String) -> Date? {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.date(from: value)
}

private func dateFromTime(_ value: String) -> Date? {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "HH:mm"
    return formatter.date(from: value)
}

private func timeKey(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
}

private func shortDay(_ value: String) -> String {
    dateFromDay(value)?.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()) ?? value
}

private func shiftDay(_ value: String, by days: Int) -> String {
    guard let date = dateFromDay(value), let shifted = Calendar.current.date(byAdding: .day, value: days, to: date) else { return value }
    return WorkspaceFormat.dayKey(shifted)
}

private func nextHour(_ value: String) -> String {
    guard let date = dateFromTime(value), let next = Calendar.current.date(byAdding: .hour, value: 1, to: date) else { return value }
    return timeKey(next)
}

private func clockLabel(_ value: String) -> String {
    dateFromTime(value)?.formatted(date: .omitted, time: .shortened) ?? value
}

private func minutesLabel(_ minutes: Int) -> String {
    let hours = minutes / 60
    let remainder = minutes % 60
    if hours == 0 { return "\(remainder)m" }
    if remainder == 0 { return "\(hours)h" }
    return "\(hours)h \(remainder)m"
}

private func eventOccurs(_ event: RemoteEvent, on day: String) -> Bool {
    event.startDate <= day && (event.endDate > day || (event.endDate == day && !event.allDay && event.endTime != "00:00"))
}

private func taskMetadata(_ task: RemoteTask, relativeTo day: String) -> String {
    var values: [String] = []
    if let dueDate = task.dueDate {
        values.append(dueDate < day ? "Overdue" : shortDay(dueDate))
    }
    if let time = task.dueTime { values.append(clockLabel(time)) }
    if let deadline = task.deadline {
        if deadline < day {
            values.append("Deadline overdue \(shortDay(deadline))")
        } else if deadline == day {
            values.append("Deadline today")
        } else {
            values.append("Deadline \(shortDay(deadline))")
        }
    }
    values.append(task.sourceName)
    if task.recurring { values.append("Repeats") }
    return values.joined(separator: " · ")
}

private func enumTitle(_ rawValue: String) -> String {
    rawValue.replacingOccurrences(of: "-", with: " ").split(separator: " ")
        .map { $0.prefix(1).uppercased() + $0.dropFirst() }
        .joined(separator: " ")
}

// MARK: - Climbing

private enum ClimbingSection: String, CaseIterable, Identifiable {
    case sessions = "Sessions"
    case plans = "Plans"
    case goals = "Goals"
    case routines = "Routines"
    var id: String { rawValue }
}

struct ClimbingView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Binding var selectedDay: Date
    let openSettings: () -> Void

    @State private var section: ClimbingSection = .sessions
    @State private var sessionDraft: ClimbingEditorDraft<ClimbingSession>?
    @State private var planDraft: ClimbingEditorDraft<ClimbingPlan>?
    @State private var goalDraft: ClimbingEditorDraft<ClimbingGoal>?
    @State private var routineDraft: ClimbingEditorDraft<ClimbingRoutine>?
    @State private var eventDraft: RemoteEventDraft?
    @State private var taskDraft: RemoteTaskDraft?

    private var day: String { WorkspaceFormat.dayKey(selectedDay) }
    private var sessions: [ClimbingSession] {
        store.climbing.sessions.filter { $0.deletedAt == nil }.sorted { $0.date > $1.date }
    }
    private var plans: [ClimbingPlan] {
        store.climbing.plans.sorted {
            if $0.status != $1.status { return $0.status == .planned }
            return effectiveDay($0) < effectiveDay($1)
        }
    }
    private var goals: [ClimbingGoal] {
        store.climbing.goals.filter { $0.archivedAt == nil }.sorted { $0.updatedAt > $1.updatedAt }
    }
    private var routines: [ClimbingRoutine] {
        store.climbing.routines.filter { !$0.archived }.sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        List {
            WorkspaceStatusBanner(openSettings: openSettings, errorArea: .climbing)
            if store.hasWorkspaceAccess && !store.loadedAreas.contains(.climbing) && !store.connectionNeedsAttention {
                Section {
                    EmptyRow(
                        icon: store.isLoading(.climbing) ? "arrow.clockwise" : "desktopcomputer",
                        title: store.isLoading(.climbing) ? "Loading Climbing" : "First sync needed",
                        detail: store.isLoading(.climbing)
                            ? "Workspace is loading the latest climbing snapshot."
                            : "Sync with your Mac once to bring your climbing log to this device."
                    )
                    if store.isLoading(.climbing) { ProgressView() }
                }
            }
            if store.hasWorkspaceAccess && store.loadedAreas.contains(.climbing) {
                SettingsAttentionSection(area: .integrations, message: "Calendar or Todoist items need attention.", openSettings: openSettings)
                if let conflict = store.climbingConflict {
                Section {
                    Label("The Mac changed while you were editing", systemImage: "arrow.triangle.2.circlepath")
                        .foregroundStyle(.orange)
                    Text(conflict.message).font(.caption).foregroundStyle(.secondary)
                    Button("Use the Mac version") { store.discardClimbingConflict() }
                }
            }
            Section {
                Picker("Climbing view", selection: $section) {
                    ForEach(ClimbingSection.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }

                switch section {
                case .sessions: sessionRows
                case .plans: planRows
                case .goals: goalRows
                case .routines: routineRows
                }
            }
        }
        .navigationTitle("Climbing")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: openSettings) {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Settings")
            }
        }
        .task {
            guard store.hasWorkspaceAccess else { return }
            await store.load(.climbing)
            await store.load(.integrations)
            await store.load(.health)
        }
        .sheet(item: $sessionDraft) { ClimbingSessionEditor(draft: $0) }
        .sheet(item: $planDraft) { ClimbingPlanEditor(draft: $0) }
        .sheet(item: $goalDraft) { ClimbingGoalEditor(draft: $0) }
        .sheet(item: $routineDraft) { ClimbingRoutineEditor(draft: $0) }
        .sheet(item: $eventDraft) { CalendarEventEditor(draft: $0) }
        .sheet(item: $taskDraft) { TodoistTaskEditor(draft: $0) }
    }

    @ViewBuilder private var sessionRows: some View {
        Section {
            if sessions.isEmpty {
                EmptyRow(icon: "mountain.2", title: "Start your climbing log", detail: "Record a gym or outdoor session, then connect its workout from Apple Health.")
            } else {
                ForEach(sessions) { session in
                    Button { presentExistingSession(id: session.id) } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(session.venue.nilIfEmpty ?? enumTitle(session.focus.rawValue)).font(.headline)
                                Spacer()
                                Text(shortDay(session.date)).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(sessionDetails(session)).font(.subheadline).foregroundStyle(.secondary)
                            if session.healthWorkoutId != nil {
                                Label("Apple Health workout linked", systemImage: "heart.fill")
                                    .font(.caption).foregroundStyle(.pink)
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                }
            }
            Button { presentNewSession(.new(date: day)) } label: { Label("Log a session", systemImage: "plus") }
        } header: { Text("Recent sessions") }
    }

    @ViewBuilder private var planRows: some View {
        Section {
            if plans.isEmpty {
                EmptyRow(icon: "calendar.badge.plus", title: "Put climbing on the calendar", detail: "Plan the intent here, then choose whether to add it to Google Calendar.")
            } else {
                ForEach(plans) { plan in
                    VStack(alignment: .leading, spacing: 8) {
                        Button { presentExistingPlan(id: plan.id) } label: {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(plan.title).font(.headline).foregroundStyle(.primary)
                                    Text(planDetails(plan)).font(.subheadline).foregroundStyle(.secondary)
                                    HStack(spacing: 10) {
                                        if eventLink(for: plan) != nil {
                                            Label("Calendar", systemImage: "calendar").foregroundStyle(.blue)
                                        }
                                        if plan.routine != nil {
                                            Label("Routine", systemImage: "list.bullet.clipboard").foregroundStyle(.orange)
                                        }
                                    }
                                    .font(.caption)
                                }
                                Spacer()
                                Text(enumTitle(plan.status.rawValue)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if plan.status == .planned {
                            HStack {
                                Button("Log session", systemImage: "checkmark.circle") { logSession(fromPlanID: plan.id) }
                                    .buttonStyle(.borderless)
                                Spacer()
                                if eventLink(for: plan) == nil, store.integrations.google.connected {
                                    Button("Add to Calendar", systemImage: "calendar.badge.plus") { schedule(planID: plan.id) }
                                        .buttonStyle(.borderless)
                                }
                            }
                            .font(.subheadline.weight(.semibold))
                            if eventLink(for: plan) != nil && linkedEvent(for: plan) == nil {
                                Label("Calendar link unavailable. Sync or forget the old link in Settings.", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                                    .font(.caption).foregroundStyle(.orange)
                            }
                        }
                    }
                }
            }
            Button { presentNewPlan(.new(date: day)) } label: { Label("Plan a session", systemImage: "plus") }
        } header: { Text("Plans") }
          footer: { Text("Calendar additions are always reviewed before they are written to Google.") }
    }

    @ViewBuilder private var goalRows: some View {
        Section {
            if goals.isEmpty {
                EmptyRow(icon: "target", title: "Choose what you are working toward", detail: "Track a project, skill, training block, or simple consistency goal.")
            } else {
                ForEach(goals) { goal in
                    let referenceCount = store.climbing.goalReferences.filter { $0.goalId == goal.id }.count
                    VStack(alignment: .leading, spacing: 8) {
                        Button { presentExistingGoal(id: goal.id) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Text(goal.title).font(.headline).foregroundStyle(.primary)
                                    Spacer()
                                    Text(goal.kind == .project ? projectStatusLabel(goal) : goalProgress(goal).label)
                                        .font(.caption.weight(.semibold)).foregroundStyle(WorkspaceBrand.signal)
                                }
                                if goal.kind == .project {
                                    let details = projectDetails(goal)
                                    if !details.isEmpty {
                                        Text(details).font(.subheadline).foregroundStyle(.secondary)
                                    }
                                    HStack(spacing: 12) {
                                        if let attempts = goal.attempts {
                                            Label("\(attempts) \(attempts == 1 ? "attempt" : "attempts")", systemImage: "arrow.counterclockwise")
                                        }
                                        if let targetDate = goal.targetDate {
                                            Label(shortDay(targetDate), systemImage: "calendar")
                                        }
                                        if referenceCount > 0 {
                                            Label("\(referenceCount) beta", systemImage: "play.rectangle")
                                        }
                                    }
                                    .font(.caption).foregroundStyle(.secondary)
                                } else {
                                    ProgressView(value: goalProgress(goal).percent, total: 100).tint(WorkspaceBrand.signal)
                                }
                                if !goal.nextStep.isEmpty { Text("Next: \(goal.nextStep)").font(.subheadline).foregroundStyle(.secondary) }
                            }
                        }
                        if taskLink(for: goal) != nil {
                            if let task = linkedTask(for: goal) {
                                Button { openLinkedTask(goalID: goal.id) } label: {
                                    Label("Todoist · \(task.title)", systemImage: "checkmark.circle")
                                }
                                .buttonStyle(.borderless).font(.caption)
                            } else {
                                Label("Todoist link unavailable. Sync or forget the old link in Settings.", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                                    .font(.caption).foregroundStyle(.orange)
                            }
                        } else if !goal.nextStep.isEmpty, store.integrations.todoist.connected {
                            Button("Send next step to Todoist", systemImage: "arrow.up.right.square") { sendToTodoist(goalID: goal.id) }
                                .buttonStyle(.borderless).font(.subheadline.weight(.semibold))
                        }
                    }
                }
            }
            Button { presentNewGoal(.new()) } label: { Label("Add a goal", systemImage: "plus") }
        } header: { Text("Active goals") }
    }

    @ViewBuilder private var routineRows: some View {
        Section {
            if routines.isEmpty {
                EmptyRow(icon: "list.bullet.clipboard", title: "Build a reusable routine", detail: "Give each step a prescription, rest period, and coaching note.")
            } else {
                ForEach(routines) { routine in
                    Button { presentExistingRoutine(id: routine.id) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(routine.title).font(.headline).foregroundStyle(.primary)
                                Text([enumTitle(routine.focus.rawValue), routine.estimatedMinutes.map(minutesLabel), "\(routine.steps.count) steps"].compactMap { $0 }.joined(separator: " · "))
                                    .font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            Button { presentNewRoutine(.new()) } label: { Label("Add a routine", systemImage: "plus") }
        } header: { Text("Training routines") }
    }

    private func createForSection() {
        switch section {
        case .sessions: presentNewSession(.new(date: day))
        case .plans: presentNewPlan(.new(date: day))
        case .goals: presentNewGoal(.new())
        case .routines: presentNewRoutine(.new())
        }
    }

    private func presentExistingSession(id: String) {
        let openingState = store.climbing
        guard let value = openingState.sessions.first(where: { $0.id == id && $0.deletedAt == nil }) else {
            store.reportStaleRow("climbing session", area: .climbing)
            return
        }
        sessionDraft = ClimbingEditorDraft(value: value, openingState: openingState, isNew: false)
    }

    private func presentNewSession(_ value: ClimbingSession) {
        sessionDraft = ClimbingEditorDraft(value: value, openingState: store.climbing, isNew: true)
    }

    private func presentExistingPlan(id: String) {
        let openingState = store.climbing
        guard let value = openingState.plans.first(where: { $0.id == id }) else {
            store.reportStaleRow("climbing plan", area: .climbing)
            return
        }
        planDraft = ClimbingEditorDraft(value: value, openingState: openingState, isNew: false)
    }

    private func presentNewPlan(_ value: ClimbingPlan) {
        planDraft = ClimbingEditorDraft(value: value, openingState: store.climbing, isNew: true)
    }

    private func presentExistingGoal(id: String) {
        let openingState = store.climbing
        guard let value = openingState.goals.first(where: { $0.id == id && $0.archivedAt == nil }) else {
            store.reportStaleRow("climbing goal", area: .climbing)
            return
        }
        goalDraft = ClimbingEditorDraft(value: value, openingState: openingState, isNew: false)
    }

    private func presentNewGoal(_ value: ClimbingGoal) {
        goalDraft = ClimbingEditorDraft(value: value, openingState: store.climbing, isNew: true)
    }

    private func presentExistingRoutine(id: String) {
        let openingState = store.climbing
        guard let value = openingState.routines.first(where: { $0.id == id && !$0.archived }) else {
            store.reportStaleRow("climbing routine", area: .climbing)
            return
        }
        routineDraft = ClimbingEditorDraft(value: value, openingState: openingState, isNew: false)
    }

    private func presentNewRoutine(_ value: ClimbingRoutine) {
        routineDraft = ClimbingEditorDraft(value: value, openingState: store.climbing, isNew: true)
    }

    private func eventLink(for plan: ClimbingPlan) -> IntegrationLink? {
        store.integrations.links.first { $0.entityKind == .plan && $0.entityId == plan.id && $0.role == .scheduledSession }
    }

    private func linkedEvent(for plan: ClimbingPlan) -> RemoteEvent? {
        guard let link = eventLink(for: plan) else { return nil }
        return store.integrations.events.first { $0.id == link.remoteId }
    }

    private func taskLink(for goal: ClimbingGoal) -> IntegrationLink? {
        store.integrations.links.first { $0.entityKind == .goal && $0.entityId == goal.id && $0.role == .goalNextStep }
    }

    private func linkedTask(for goal: ClimbingGoal) -> RemoteTask? {
        guard let link = taskLink(for: goal) else { return nil }
        return store.integrations.tasks.first { $0.id == link.remoteId }
    }

    private func effectiveDay(_ plan: ClimbingPlan) -> String { linkedEvent(for: plan)?.startDate ?? plan.date }

    private func planDetails(_ plan: ClimbingPlan) -> String {
        let event = linkedEvent(for: plan)
        let when = [shortDay(event?.startDate ?? plan.date), (event?.startTime ?? plan.startTime).map(clockLabel)].compactMap { $0 }.joined(separator: " at ")
        return [when, event?.location.nilIfEmpty ?? plan.venue.nilIfEmpty, enumTitle(plan.focus.rawValue)].compactMap { $0 }.joined(separator: " · ")
    }

    private func sessionDetails(_ session: ClimbingSession) -> String {
        [enumTitle(session.environment.rawValue), enumTitle(session.focus.rawValue), session.durationMinutes.map(minutesLabel), session.climbs.isEmpty ? nil : "\(session.climbs.count) climbs"]
            .compactMap { $0 }.joined(separator: " · ")
    }

    private func logSession(fromPlanID id: String) {
        let openingState = store.climbing
        guard let plan = openingState.plans.first(where: { $0.id == id && $0.status == .planned }) else {
            store.reportStaleRow("climbing plan", area: .climbing)
            return
        }
        let event = linkedEvent(for: plan)
        var result = ClimbingSession.new(date: event?.startDate ?? plan.date)
        result.environment = plan.environment
        result.venue = event?.location.nilIfEmpty ?? plan.venue
        result.focus = plan.focus
        result.planId = plan.id
        result.routine = plan.routine
        result.durationMinutes = nil
        sessionDraft = ClimbingEditorDraft(value: result, openingState: openingState, isNew: true)
    }

    private func schedule(planID id: String) {
        let openingState = store.climbing
        guard let plan = openingState.plans.first(where: { $0.id == id && $0.status == .planned }) else {
            store.reportStaleRow("climbing plan", area: .climbing)
            return
        }
        guard eventLink(for: plan) == nil else {
            store.reportStaleRow("climbing plan schedule", area: .climbing)
            return
        }
        eventDraft = RemoteEventDraft(
            event: nil,
            day: plan.date,
            presetTitle: plan.title,
            presetLocation: plan.venue,
            link: IntegrationLinkRequest(entityKind: .plan, entityId: plan.id, role: .scheduledSession)
        )
    }

    private func sendToTodoist(goalID id: String) {
        let openingState = store.climbing
        guard let goal = openingState.goals.first(where: { $0.id == id && $0.archivedAt == nil }) else {
            store.reportStaleRow("climbing goal", area: .climbing)
            return
        }
        guard !goal.nextStep.isEmpty, taskLink(for: goal) == nil else {
            store.reportStaleRow("climbing goal action", area: .climbing)
            return
        }
        taskDraft = RemoteTaskDraft(
            task: nil,
            day: goal.targetDate ?? day,
            link: IntegrationLinkRequest(entityKind: .goal, entityId: goal.id, role: .goalNextStep),
            presetTitle: goal.nextStep
        )
    }

    private func openLinkedTask(goalID id: String) {
        let openingState = store.climbing
        guard let goal = openingState.goals.first(where: { $0.id == id && $0.archivedAt == nil }) else {
            store.reportStaleRow("climbing goal", area: .climbing)
            return
        }
        guard let link = store.integrations.links.first(where: {
            $0.entityKind == .goal && $0.entityId == goal.id && $0.role == .goalNextStep
        }), let task = store.integrations.tasks.first(where: { $0.id == link.remoteId }) else {
            store.reportStaleRow("linked Todoist task", area: .integrations)
            return
        }
        taskDraft = RemoteTaskDraft(task: task, day: goal.targetDate ?? day, link: nil)
    }

    private func goalProgress(_ goal: ClimbingGoal) -> (percent: Double, label: String) {
        guard goal.kind == .consistency,
              let start = goal.startDate,
              let end = goal.targetDate,
              let target = goal.sessionTarget else {
            return (Double(goal.progress), "\(goal.progress)%")
        }
        let completed = sessions.filter { $0.date >= start && $0.date <= end }.count
        let percent = min(100, Double(completed) / Double(target) * 100)
        return (percent, "\(completed) of \(target) sessions")
    }

    private func projectStatusLabel(_ goal: ClimbingGoal) -> String {
        switch goal.status {
        case .active: "Projecting"
        case .paused: "Paused"
        case .completed: "Sent"
        }
    }

    private func projectDetails(_ goal: ClimbingGoal) -> String {
        let setting = goal.environment.map { $0 == .indoor ? "Indoor" : "Outside" }
        let climbType: String? = switch goal.discipline {
        case .boulder: "Boulder"
        case .route: goal.ropeStyle.map { enumTitle($0.rawValue) } ?? "Route"
        case nil: nil
        }
        return [[setting, climbType].compactMap { $0 }.joined(separator: " ").nilIfEmpty, goal.grade, goal.venue]
            .compactMap { $0?.nilIfEmpty }
            .joined(separator: " · ")
    }
}

private func preferredHealthWorkouts(
    on day: String,
    localSnapshot: HealthSnapshot?,
    remoteSnapshot: PhoneHealthSnapshot?
) -> [UnifiedHealthWorkout] {
    let local = localSnapshot?.workouts.map {
        UnifiedHealthWorkout(
            id: $0.id.uuidString,
            name: $0.name,
            start: $0.start,
            timeZoneIdentifier: $0.timeZone,
            snapshotTimeZoneIdentifier: localSnapshot?.timeZone,
            minutes: $0.minutes,
            activity: $0.activity,
            source: $0.sourceName
        )
    } ?? []
    let remote = remoteSnapshot?.workouts.map {
        UnifiedHealthWorkout(
            id: $0.id,
            name: $0.name,
            start: $0.start,
            timeZoneIdentifier: $0.timeZone,
            snapshotTimeZoneIdentifier: remoteSnapshot?.timeZone,
            minutes: $0.minutes,
            activity: $0.activity.rawValue,
            source: $0.sourceName ?? "Apple Health"
        )
    } ?? []
    return WorkspaceFormat.preferredHealthWorkouts(on: day, local: local, remote: remote)
}

private struct HealthWorkoutChoice: Identifiable, Hashable {
    let id: String
    let name: String
    let date: String
    let minutes: Int
    let source: String
}

private struct ClimbingEditorConflictSection: View {
    @EnvironmentObject private var store: WorkspaceStore

    var body: some View {
        if let conflict = store.climbingConflict {
            Section {
                Label("The Mac changed while you were editing", systemImage: "arrow.triangle.2.circlepath")
                    .foregroundStyle(.orange)
                Text(conflict.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Your fields are still here for review or copying. Close this editor, review the Mac version, then reopen the item before saving again.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct ClimbingSessionEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let original: ClimbingSession
    @State private var value: ClimbingSession
    @State private var openingState: ClimbingState
    @State private var wasNew: Bool
    @State private var climbDraft: Climb?
    @State private var confirmDelete = false

    init(draft: ClimbingEditorDraft<ClimbingSession>) {
        original = draft.value
        _value = State(initialValue: draft.value)
        _openingState = State(initialValue: draft.openingState)
        _wasNew = State(initialValue: draft.isNew)
    }

    private var isNew: Bool { wasNew }
    private var dirty: Bool { value != original }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .climbing)
                ClimbingEditorConflictSection()
                Section("Session") {
                    DayField("Date", value: $value.date)
                    Picker("Setting", selection: $value.environment) {
                        ForEach(ClimbingEnvironment.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                    TextField(value.environment == .indoor ? "Gym" : "Crag or area", text: $value.venue)
                    Picker("Focus", selection: $value.focus) {
                        ForEach(ClimbingFocus.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                }

                Section("How it felt") {
                    Toggle("Record duration", isOn: optionalIntToggle($value.durationMinutes, defaultValue: 90))
                    if value.durationMinutes != nil {
                        Stepper("Duration · \(minutesLabel(value.durationMinutes ?? 90))", value: optionalInt($value.durationMinutes, defaultValue: 90), in: 5...900, step: 5)
                    }
                    Toggle("Record effort", isOn: optionalIntToggle($value.effort, defaultValue: 6))
                    if value.effort != nil {
                        Stepper("Effort · \(value.effort ?? 6) / 10", value: optionalInt($value.effort, defaultValue: 6), in: 1...10)
                    }
                    Picker("Readiness", selection: Binding(
                        get: { value.readiness?.rawValue ?? "none" },
                        set: { value.readiness = $0 == "none" ? nil : ClimbingReadiness(rawValue: $0) }
                    )) {
                        Text("Not recorded").tag("none")
                        ForEach(ClimbingReadiness.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0.rawValue) }
                    }
                }

                Section("Training routine") {
                    Picker("Routine", selection: Binding(
                        get: { value.routine?.routineId ?? "none" },
                        set: { id in
                            value.routine = id == "none" ? nil : openingState.routines.first(where: { $0.id == id }).map(ClimbingRoutineExecution.init(snapshotOf:))
                        }
                    )) {
                        Text("No routine").tag("none")
                        ForEach(openingState.routines.filter { !$0.archived }) { Text($0.title).tag($0.id) }
                    }
                    if let routine = value.routine {
                        Text("\(routine.steps.count) steps · saved as version \(routine.version)")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(Array(routine.steps.enumerated()), id: \.element.id) { index, step in
                            RoutineExecutionStepRow(
                                step: step,
                                status: Binding(
                                    get: { value.routine?.steps[index].status ?? .notLogged },
                                    set: { value.routine?.steps[index].status = $0 }
                                ),
                                result: Binding(
                                    get: { value.routine?.steps[index].result ?? "" },
                                    set: { value.routine?.steps[index].result = $0 }
                                )
                            )
                        }
                    }
                }

                Section("Climbs") {
                    if value.climbs.isEmpty {
                        Text("Add notable climbs, projects, or attempts from the session.").foregroundStyle(.secondary)
                    } else {
                        ForEach(value.climbs) { climb in
                            Button { climbDraft = climb } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(climb.name.nilIfEmpty ?? "Unnamed climb").foregroundStyle(.primary)
                                        Text(climbDetails(climb)).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                                }
                            }
                        }
                        .onDelete { value.climbs.remove(atOffsets: $0) }
                    }
                    Button { climbDraft = .new(discipline: value.focus == .routes ? .route : .boulder) } label: {
                        Label("Add a climb", systemImage: "plus")
                    }
                }

                Section("Apple Health") {
                    Picker("Workout", selection: Binding(
                        get: { value.healthWorkoutId ?? "none" },
                        set: { value.healthWorkoutId = $0 == "none" ? nil : $0 }
                    )) {
                        Text("No linked workout").tag("none")
                        ForEach(workoutChoices) { workout in
                            Text("\(workout.name) · \(minutesLabel(workout.minutes)) · \(workout.source)").tag(workout.id)
                        }
                    }
                    if workoutChoices.isEmpty {
                        Text("No Health workouts are available for this date. Update Health from Settings.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("This stores a reference to the Health workout. It does not change Apple Health.").font(.caption).foregroundStyle(.secondary)
                    }
                }

                Section("Notes") {
                    TextField("What worked, what felt hard, what to remember", text: $value.notes, axis: .vertical)
                        .lineLimit(4...12)
                }

                if !isNew {
                    Section {
                        Button("Delete session", role: .destructive) { confirmDelete = true }
                            .disabled(store.climbingConflict != nil)
                    }
                }
            }
            .navigationTitle(isNew ? "Log session" : "Edit session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(value.venue.nilIfEmpty == nil || store.climbingConflict != nil)
                }
            }
            .interactiveDismissDisabled(dirty)
            .sheet(item: $climbDraft) { climb in
                ClimbEditor(climb: climb) { updated in
                    if let index = value.climbs.firstIndex(where: { $0.id == updated.id }) { value.climbs[index] = updated }
                    else { value.climbs.append(updated) }
                }
            }
            .confirmationDialog("Delete this climbing session?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete session", role: .destructive) { delete() }
                    .disabled(store.climbingConflict != nil)
                Button("Keep session", role: .cancel) { }
            } message: { Text("The session will be removed from the active log on your Mac.") }
        }
    }

    private var workoutChoices: [HealthWorkoutChoice] {
        let result = preferredHealthWorkouts(
            on: value.date,
            localSnapshot: store.healthSnapshot,
            remoteSnapshot: store.healthView?.snapshot
        ).map {
            HealthWorkoutChoice(
                id: $0.id,
                name: $0.name,
                date: value.date,
                minutes: Int($0.minutes.rounded()),
                source: $0.source
            )
        }
        let reserved = Set(openingState.sessions.compactMap { session in
            session.id == value.id ? nil : session.healthWorkoutId?.lowercased()
        })
        var available = result.filter { !reserved.contains($0.id.lowercased()) }
        if let selected = value.healthWorkoutId, !available.contains(where: { $0.id.caseInsensitiveCompare(selected) == .orderedSame }) {
            available.append(HealthWorkoutChoice(id: selected, name: "Linked workout", date: value.date, minutes: 0, source: "Unavailable in latest Health snapshot"))
        }
        return available
            .sorted { $0.name < $1.name }
    }

    private func climbDetails(_ climb: Climb) -> String {
        [climb.grade, enumTitle(climb.outcome.rawValue), climb.attempts.map { "\($0) attempts" }].compactMap { $0 }.joined(separator: " · ")
    }

    private func optionalInt(_ binding: Binding<Int?>, defaultValue: Int) -> Binding<Int> {
        Binding(get: { binding.wrappedValue ?? defaultValue }, set: { binding.wrappedValue = $0 })
    }

    private func optionalIntToggle(_ binding: Binding<Int?>, defaultValue: Int) -> Binding<Bool> {
        Binding(get: { binding.wrappedValue != nil }, set: { binding.wrappedValue = $0 ? defaultValue : nil })
    }

    private func save() {
        value.venue = value.venue.trimmingCharacters(in: .whitespacesAndNewlines)
        value.notes = value.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        value.updatedAt = WorkspaceFormat.timestamp()
        let saved = value
        Task {
            if await store.upsertClimbingSession(saved, openingState: openingState, markLinkedPlanLogged: true) { dismiss() }
        }
    }

    private func delete() {
        var removed = value
        removed.deletedAt = WorkspaceFormat.timestamp()
        removed.updatedAt = WorkspaceFormat.timestamp()
        Task {
            if await store.upsertClimbingSession(removed, openingState: openingState, markLinkedPlanLogged: false) { dismiss() }
        }
    }
}

private struct RoutineExecutionStepRow: View {
    let step: ClimbingRoutineExecutionStep
    @Binding var status: RoutineStepStatus
    @Binding var result: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(step.name).font(.subheadline.weight(.semibold))
            Text([step.prescription, step.rest.nilIfEmpty.map { "Rest \($0)" }, step.notes.nilIfEmpty].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
            Picker("Status", selection: $status) {
                ForEach(RoutineStepStatus.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
            }
            if status != .notLogged {
                TextField(status == .modified ? "What changed?" : status == .skipped ? "Why skipped?" : "Result or note", text: $result, axis: .vertical)
                    .lineLimit(1...4)
            }
        }
        .padding(.vertical, 3)
    }
}

private struct ClimbEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var value: Climb
    let onSave: (Climb) -> Void

    init(climb: Climb, onSave: @escaping (Climb) -> Void) {
        _value = State(initialValue: climb)
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name or problem", text: $value.name)
                    Picker("Discipline", selection: $value.discipline) {
                        ForEach(ClimbDiscipline.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                    .onChange(of: value.discipline) { _, discipline in
                        value.ropeStyle = discipline == .route ? (value.ropeStyle ?? .topRope) : nil
                    }
                    if value.discipline == .route {
                        Picker("Rope style", selection: Binding(get: { value.ropeStyle ?? .topRope }, set: { value.ropeStyle = $0 })) {
                            ForEach(RopeStyle.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                        }
                    }
                    Picker("Grade system", selection: Binding(
                        get: { value.gradeSystem?.rawValue ?? "none" },
                        set: { value.gradeSystem = $0 == "none" ? nil : GradeSystem(rawValue: $0) }
                    )) {
                        Text("Not recorded").tag("none")
                        ForEach(GradeSystem.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0.rawValue) }
                    }
                    TextField("Grade (optional)", text: Binding(get: { value.grade ?? "" }, set: { value.grade = $0.nilIfEmpty }))
                    Picker("Outcome", selection: $value.outcome) {
                        ForEach(ClimbOutcome.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                    .onChange(of: value.outcome) { _, outcome in
                        if outcome == .flash || outcome == .onsight { value.attempts = 1 }
                    }
                    Stepper("Attempts · \(value.attempts ?? 1)", value: Binding(get: { value.attempts ?? 1 }, set: { value.attempts = $0 }), in: 1...99)
                        .disabled(value.outcome == .flash || value.outcome == .onsight)
                    TextField("Notes", text: $value.notes, axis: .vertical).lineLimit(2...8)
                }
            }
            .navigationTitle("Climb")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        if value.outcome == .flash || value.outcome == .onsight { value.attempts = 1 }
                        value.attempts = min(99, max(1, value.attempts ?? 1))
                        onSave(value)
                        dismiss()
                    }
                    .disabled(!climbIsValid)
                }
            }
        }
    }

    private var climbIsValid: Bool {
        guard value.name.nilIfEmpty != nil else { return false }
        guard (value.gradeSystem == nil) == (value.grade?.nilIfEmpty == nil) else { return false }
        if value.discipline == .boulder {
            if value.ropeStyle != nil || value.outcome == .onsight || value.outcome == .redpoint { return false }
            if let grade = value.gradeSystem, [.yds, .french, .uiaa, .uk].contains(grade) { return false }
        } else {
            if value.ropeStyle == nil { return false }
            if let grade = value.gradeSystem, [.vScale, .font].contains(grade) { return false }
        }
        return true
    }
}

private struct ClimbingPlanEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let original: ClimbingPlan
    @State private var value: ClimbingPlan
    @State private var openingState: ClimbingState
    @State private var wasNew: Bool
    @State private var hasTime: Bool

    init(draft: ClimbingEditorDraft<ClimbingPlan>) {
        original = draft.value
        _value = State(initialValue: draft.value)
        _openingState = State(initialValue: draft.openingState)
        _wasNew = State(initialValue: draft.isNew)
        _hasTime = State(initialValue: draft.value.startTime != nil)
    }

    private var isNew: Bool { wasNew }
    private var dirty: Bool { value != original }
    private var linkedSession: ClimbingSession? {
        openingState.sessions.first { $0.planId == value.id || value.sessionId == $0.id }
    }
    private var scheduleLocked: Bool {
        store.integrations.links.contains {
            $0.entityKind == .plan && $0.entityId == value.id && $0.role == .scheduledSession
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .climbing)
                ClimbingEditorConflictSection()
                Section("Plan") {
                    TextField("Title", text: $value.title)
                    DayField("Date", value: $value.date).disabled(scheduleLocked)
                    Toggle("Set a time", isOn: $hasTime).disabled(scheduleLocked)
                    if hasTime {
                        TimeField("Starts", value: Binding(get: { value.startTime ?? "18:00" }, set: { value.startTime = $0 })).disabled(scheduleLocked)
                        DayField("Ends on", value: Binding(get: { value.endDate ?? value.date }, set: { value.endDate = $0 })).disabled(scheduleLocked)
                        TimeField("Ends", value: Binding(get: { value.endTime ?? "20:00" }, set: { value.endTime = $0 })).disabled(scheduleLocked)
                    }
                    Picker("Setting", selection: $value.environment) {
                        ForEach(ClimbingEnvironment.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                    TextField(value.environment == .indoor ? "Gym" : "Crag or area", text: $value.venue)
                        .disabled(scheduleLocked)
                    Picker("Focus", selection: $value.focus) {
                        ForEach(ClimbingFocus.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                }
                Section("Related items") {
                    if scheduleLocked {
                        Label("Google Calendar supplies this plan’s date, time, and location.", systemImage: "calendar")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    Picker("Goal", selection: Binding(
                        get: { value.goalId ?? "none" },
                        set: { value.goalId = $0 == "none" ? nil : $0 }
                    )) {
                        Text("No goal").tag("none")
                        ForEach(openingState.goals.filter { $0.archivedAt == nil }) { Text($0.title).tag($0.id) }
                    }
                    Picker("Routine", selection: Binding(
                        get: { value.routine?.routineId ?? "none" },
                        set: { id in value.routine = id == "none" ? nil : openingState.routines.first(where: { $0.id == id }).map(ClimbingRoutineExecution.init(snapshotOf:)) }
                    )) {
                        Text("No routine").tag("none")
                        ForEach(openingState.routines.filter { !$0.archived }) { Text($0.title).tag($0.id) }
                    }
                    if !isNew, value.status == .logged || linkedSession != nil {
                        LabeledContent("Status", value: "Logged")
                        Text("Logged status is managed by its reciprocal session. A removed session remains reserved so the history can be restored safely.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if !isNew {
                        Picker("Status", selection: $value.status) {
                            Text("Planned").tag(ClimbingPlanStatus.planned)
                            Text("Cancelled").tag(ClimbingPlanStatus.cancelled)
                        }
                    }
                }
                if !isNew, linkedSession != nil || value.status == .logged {
                    Section {
                        Label("A linked session reserves this plan", systemImage: "link")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(isNew ? "Plan a session" : "Edit plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(value.title.nilIfEmpty == nil || store.climbingConflict != nil)
                }
            }
            .interactiveDismissDisabled(dirty)
        }
    }

    private func save() {
        value.title = value.title.trimmingCharacters(in: .whitespacesAndNewlines)
        value.venue = value.venue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !hasTime { value.startTime = nil; value.endTime = nil; value.endDate = nil }
        else { value.startTime = value.startTime ?? "18:00"; value.endTime = value.endTime ?? "20:00"; value.endDate = value.endDate ?? value.date }
        value.updatedAt = WorkspaceFormat.timestamp()
        let saved = value
        Task { if await store.upsertClimbingPlan(saved, openingState: openingState) { dismiss() } }
    }
}

private struct ClimbingGoalEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let original: ClimbingGoal
    @State private var value: ClimbingGoal
    @State private var openingState: ClimbingState
    @State private var wasNew: Bool
    @State private var hasStartDate: Bool
    @State private var hasTargetDate: Bool
    @State private var hasSessionTarget: Bool
    @State private var confirmArchive = false
    @State private var mediaSelection: PhotosPickerItem?
    @State private var mediaLabel = ""
    @State private var mediaStatus: String?
    @State private var addingMedia = false
    @State private var loadingReferenceID: String?
    @State private var referenceToDelete: ClimbingGoalReference?
    @State private var mediaPreview: ClimbingGoalMediaPreview?
    @State private var linkDraft: ClimbingGoalLinkDraft?
    @State private var mediaTask: Task<Void, Never>?
    @State private var pendingMediaFile: URL?

    init(draft: ClimbingEditorDraft<ClimbingGoal>) {
        original = draft.value
        _value = State(initialValue: draft.value)
        _openingState = State(initialValue: draft.openingState)
        _wasNew = State(initialValue: draft.isNew)
        _hasStartDate = State(initialValue: draft.value.startDate != nil)
        _hasTargetDate = State(initialValue: draft.value.targetDate != nil)
        _hasSessionTarget = State(initialValue: draft.value.sessionTarget != nil)
    }

    private var isNew: Bool { wasNew }
    private var dirty: Bool {
        normalized(
            value,
            includesStartDate: hasStartDate,
            includesTargetDate: hasTargetDate,
            includesSessionTarget: hasSessionTarget,
            updatedAt: ""
        ) != normalized(
            original,
            includesStartDate: original.startDate != nil,
            includesTargetDate: original.targetDate != nil,
            includesSessionTarget: original.sessionTarget != nil,
            updatedAt: ""
        )
    }
    private var goalReferences: [ClimbingGoalReference] {
        store.climbing.goalReferences
            .filter { $0.goalId == value.id }
            .sorted { $0.createdAt > $1.createdAt }
    }
    private var referenceLimitReached: Bool { goalReferences.count >= 12 }
    private var mediaTransferInProgress: Bool { addingMedia || loadingReferenceID != nil }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .climbing)
                ClimbingEditorConflictSection()
                Section(value.kind == .project ? "Climb project" : "Goal") {
                    TextField(value.kind == .project ? "Route or problem name" : "What are you working toward?", text: $value.title, axis: .vertical)
                        .lineLimit(2...5)
                    Picker("Type", selection: $value.kind) {
                        ForEach(ClimbingGoalKind.allCases, id: \.self) { Text(goalKindTitle($0)).tag($0) }
                    }
                    .onChange(of: value.kind) { _, kind in
                        configure(for: kind)
                    }
                    TextField(value.kind == .project ? "Project notes or beta" : "Why it matters or what success looks like", text: $value.description, axis: .vertical)
                        .lineLimit(3...8)
                    Picker("Status", selection: $value.status) {
                        ForEach(ClimbingGoalStatus.allCases, id: \.self) { Text(goalStatusTitle($0)).tag($0) }
                    }
                    if value.kind != .consistency && value.kind != .project {
                        Stepper("Progress · \(value.progress)%", value: $value.progress, in: 0...100, step: 5)
                    }
                    TextField("Next action", text: $value.nextStep, axis: .vertical).lineLimit(2...5)
                }
                if value.kind == .project {
                    Section {
                        Picker("Setting", selection: Binding(
                            get: { value.environment?.rawValue ?? "none" },
                            set: { value.environment = $0 == "none" ? nil : ClimbingEnvironment(rawValue: $0) }
                        )) {
                            Text("Choose a setting").tag("none")
                            Text("Gym").tag(ClimbingEnvironment.indoor.rawValue)
                            Text("Outside").tag(ClimbingEnvironment.outdoor.rawValue)
                        }
                        Picker("Climb type", selection: Binding(
                            get: { value.discipline?.rawValue ?? "none" },
                            set: { updateProjectDiscipline($0 == "none" ? nil : ClimbDiscipline(rawValue: $0)) }
                        )) {
                            Text("Choose a type").tag("none")
                            Text("Boulder").tag(ClimbDiscipline.boulder.rawValue)
                            Text("Roped route").tag(ClimbDiscipline.route.rawValue)
                        }
                        if value.discipline == .route {
                            Picker("Route style", selection: Binding(
                                get: { value.ropeStyle?.rawValue ?? "none" },
                                set: { value.ropeStyle = $0 == "none" ? nil : RopeStyle(rawValue: $0) }
                            )) {
                                Text("Any style").tag("none")
                                ForEach(RopeStyle.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0.rawValue) }
                            }
                        }
                        TextField("Gym, crag, or area", text: Binding(get: { value.venue ?? "" }, set: { value.venue = $0.nilIfEmpty }))
                        Picker("Grade system", selection: Binding(
                            get: {
                                guard let system = value.gradeSystem,
                                      projectGradeFits(system, discipline: value.discipline) else { return "none" }
                                return system.rawValue
                            },
                            set: {
                                let previous = value.gradeSystem
                                let next = $0 == "none" ? nil : GradeSystem(rawValue: $0)
                                value.gradeSystem = next
                                value.grade = next == nil ? nil : (next == previous ? value.grade ?? "" : "")
                            }
                        )) {
                            Text("Not specified").tag("none")
                            ForEach(allowedProjectGradeSystems, id: \.self) { Text(enumTitle($0.rawValue)).tag($0.rawValue) }
                        }
                        TextField("Grade", text: Binding(
                            get: {
                                guard let system = value.gradeSystem,
                                      projectGradeFits(system, discipline: value.discipline) else { return "" }
                                return value.grade ?? ""
                            },
                            set: { value.grade = $0.nilIfEmpty }
                        ))
                        .disabled(value.gradeSystem.map { !projectGradeFits($0, discipline: value.discipline) } ?? true)
                        Stepper(
                            "Manual attempts · \(value.attempts ?? 0)",
                            value: Binding(get: { value.attempts ?? 0 }, set: { value.attempts = $0 }),
                            in: 0...9999
                        )
                    } header: {
                        Text("Project details")
                    } footer: {
                        Text("Keep a running count here. Logged climbing sessions do not update it yet.")
                    }
                    Section("Target") {
                        Toggle("Target date", isOn: Binding(
                            get: { hasTargetDate },
                            set: { enabled in hasTargetDate = enabled; value.targetDate = enabled ? (value.targetDate ?? shiftDay(WorkspaceFormat.dayKey(), by: 28)) : nil }
                        ))
                        if hasTargetDate { DayField("Send by", value: Binding(get: { value.targetDate ?? WorkspaceFormat.dayKey() }, set: { value.targetDate = $0 })) }
                    }
                } else {
                    Section("Target") {
                        Toggle("Start date", isOn: Binding(
                            get: { hasStartDate },
                            set: { enabled in hasStartDate = enabled; value.startDate = enabled ? (value.startDate ?? WorkspaceFormat.dayKey()) : nil }
                        ))
                        if hasStartDate { DayField("Starts", value: Binding(get: { value.startDate ?? WorkspaceFormat.dayKey() }, set: { value.startDate = $0 })) }
                        Toggle("Target date", isOn: Binding(
                            get: { hasTargetDate },
                            set: { enabled in hasTargetDate = enabled; value.targetDate = enabled ? (value.targetDate ?? shiftDay(WorkspaceFormat.dayKey(), by: 28)) : nil }
                        ))
                        if hasTargetDate { DayField("By", value: Binding(get: { value.targetDate ?? WorkspaceFormat.dayKey() }, set: { value.targetDate = $0 })) }
                        if value.kind == .consistency {
                            Toggle("Session target", isOn: Binding(
                                get: { hasSessionTarget },
                                set: { enabled in hasSessionTarget = enabled; value.sessionTarget = enabled ? (value.sessionTarget ?? 8) : nil }
                            ))
                            if hasSessionTarget {
                                Stepper("Sessions · \(value.sessionTarget ?? 8)", value: Binding(get: { value.sessionTarget ?? 8 }, set: { value.sessionTarget = $0 }), in: 1...365)
                            }
                        }
                        if value.kind == .training {
                            Picker("Routine", selection: Binding(get: { value.routineId ?? "none" }, set: { value.routineId = $0 == "none" ? nil : $0 })) {
                                Text("No routine").tag("none")
                                ForEach(openingState.routines.filter { !$0.archived }) { Text($0.title).tag($0.id) }
                            }
                        }
                    }
                }
                if !isNew {
                    betaSection
                }
                if !isNew {
                    Section {
                        Button("Archive goal", role: .destructive) { confirmArchive = true }
                            .disabled(store.climbingConflict != nil || mediaTransferInProgress)
                    }
                }
            }
            .navigationTitle(value.kind == .project ? (isNew ? "New project" : "Edit project") : (isNew ? "New goal" : "Edit goal"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(mediaTransferInProgress)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(!goalIsValid || store.climbingConflict != nil || mediaTransferInProgress)
                }
            }
            .interactiveDismissDisabled(dirty || mediaTransferInProgress)
            .onChange(of: mediaSelection) { _, selection in
                guard let selection else { return }
                mediaTask?.cancel()
                mediaTask = Task { await addMedia(selection) }
            }
            .sheet(item: $mediaPreview, onDismiss: cleanupPendingMediaFile) {
                ClimbingGoalMediaPreviewView(preview: $0)
            }
            .sheet(item: $linkDraft) { ClimbingGoalLinkEditor(draft: $0) }
            .onDisappear(perform: cancelMediaTransfer)
            .confirmationDialog(
                "Remove this reference?",
                isPresented: Binding(
                    get: { referenceToDelete != nil },
                    set: { if !$0 { referenceToDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Remove", role: .destructive) {
                    guard let reference = referenceToDelete else { return }
                    referenceToDelete = nil
                    Task { _ = await store.deleteClimbingGoalReference(reference) }
                }
                Button("Cancel", role: .cancel) { referenceToDelete = nil }
            }
            .confirmationDialog("Archive this goal?", isPresented: $confirmArchive, titleVisibility: .visible) {
                Button("Archive goal", role: .destructive) { archive() }
                    .disabled(store.climbingConflict != nil || mediaTransferInProgress)
                Button("Keep active", role: .cancel) { }
            } message: { Text("Its history stays in the Workspace. Any linked Todoist task remains in Todoist.") }
        }
    }

    @ViewBuilder private var betaSection: some View {
        Section {
            if goalReferences.isEmpty {
                Text("No photos, videos, or links yet.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(goalReferences) { reference in
                    Button { open(reference) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: referenceIcon(reference))
                                .foregroundStyle(WorkspaceBrand.signal)
                                .frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(reference.label).foregroundStyle(.primary)
                                Text(referenceDetail(reference))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if loadingReferenceID == reference.id {
                                ProgressView()
                            } else {
                                Image(systemName: reference.kind == .link ? "arrow.up.right" : "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .disabled(mediaTransferInProgress)
                    .swipeActions {
                        Button(role: .destructive) { referenceToDelete = reference } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
            }

            TextField("Label (optional)", text: $mediaLabel)
                .disabled(mediaTransferInProgress || referenceLimitReached)
            PhotosPicker(
                selection: $mediaSelection,
                matching: .any(of: [.images, .videos]),
                photoLibrary: .shared()
            ) {
                Label("Add photo or video", systemImage: "photo.on.rectangle.angled")
            }
            .disabled(mediaTransferInProgress || referenceLimitReached || store.climbingConflict != nil)
            Button { linkDraft = ClimbingGoalLinkDraft(goalId: value.id) } label: {
                Label("Add link", systemImage: "link.badge.plus")
            }
            .disabled(mediaTransferInProgress || referenceLimitReached || store.climbingConflict != nil)

            if referenceLimitReached {
                Text("This goal has 12 references. Remove one to add another.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if addingMedia {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Adding attachment…").foregroundStyle(.secondary)
                }
            } else if let mediaStatus {
                Text(mediaStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Beta")
        } footer: {
            Text("Choose one photo or video up to 200 MB. Workspace transfers it directly to your paired Mac.")
        }
    }

    private func referenceIcon(_ reference: ClimbingGoalReference) -> String {
        switch reference.kind {
        case .link: "link"
        case .image: "photo"
        case .video: "play.rectangle"
        }
    }

    private func referenceDetail(_ reference: ClimbingGoalReference) -> String {
        switch reference.kind {
        case .link:
            return reference.url.flatMap { URL(string: $0)?.host } ?? "Link"
        case .image, .video:
            let kind = reference.kind == .image ? "Photo" : "Video"
            guard let byteSize = reference.byteSize else { return kind }
            return "\(kind) · \(ByteCountFormatter.string(fromByteCount: Int64(byteSize), countStyle: .file))"
        }
    }

    private func open(_ reference: ClimbingGoalReference) {
        if reference.kind == .link {
            guard let value = reference.url,
                  let components = URLComponents(string: value),
                  components.scheme == "https",
                  components.host != nil,
                  let url = components.url else {
                mediaStatus = "This link is invalid."
                return
            }
            openURL(url)
            return
        }

        mediaTask?.cancel()
        cleanupPendingMediaFile()
        loadingReferenceID = reference.id
        mediaStatus = nil
        mediaTask = Task {
            defer { loadingReferenceID = nil }
            let file = await store.downloadClimbingGoalReference(reference)
            guard let file else { return }
            guard !Task.isCancelled else {
                try? FileManager.default.removeItem(at: file)
                return
            }
            pendingMediaFile = file
            mediaPreview = ClimbingGoalMediaPreview(reference: reference, file: file)
        }
    }

    private func addMedia(_ selection: PhotosPickerItem) async {
        addingMedia = true
        mediaStatus = nil
        defer {
            addingMedia = false
            mediaSelection = nil
        }

        do {
            guard let transfer = try await selection.loadTransferable(type: ClimbingMediaTransfer.self) else {
                throw BridgeError.message("Workspace could not read that photo or video.")
            }
            defer { try? FileManager.default.removeItem(at: transfer.file) }
            try Task.checkCancellation()

            let selectedType = selection.supportedContentTypes.first {
                $0.conforms(to: .image) || $0.conforms(to: .movie)
            }
            let type = selectedType
                ?? UTType(filenameExtension: transfer.file.pathExtension)
                ?? (transfer.kind == .image ? .jpeg : .quickTimeMovie)
            let isImage = type.conforms(to: .image) || transfer.kind == .image
            let preferredContentType = type.preferredMIMEType ?? ""
            let acceptedContentTypes: Set<String> = [
                "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
                "video/mp4", "video/quicktime",
            ]
            let contentType = acceptedContentTypes.contains(preferredContentType)
                ? preferredContentType
                : "application/octet-stream"
            let values = try transfer.file.resourceValues(forKeys: [.fileSizeKey])
            guard let byteCount = values.fileSize,
                  byteCount > 0,
                  byteCount <= BridgeClient.maximumMediaBytes else {
                throw BridgeError.message("Choose a photo or video smaller than 200 MB.")
            }

            let defaultLabel = isImage ? "Beta photo" : "Beta video"
            let label = prefixByUTF16Units(mediaLabel.nilIfEmpty ?? defaultLabel, limit: 120)
            let fallbackExtension = type.preferredFilenameExtension ?? (isImage ? "jpg" : "mov")
            let fileName = safeMediaFileName(transfer.fileName, fallbackExtension: fallbackExtension)
            let saved = await store.uploadClimbingGoalMedia(
                goalId: value.id,
                referenceId: UUID().uuidString.lowercased(),
                requestId: UUID().uuidString.lowercased(),
                label: label,
                fileName: fileName,
                contentType: contentType,
                file: transfer.file
            )
            guard !Task.isCancelled else { return }
            if saved {
                mediaLabel = ""
                mediaStatus = "Attachment added."
            } else {
                mediaStatus = "Attachment wasn’t added."
            }
        } catch {
            guard !Task.isCancelled,
                  !(error is CancellationError),
                  (error as? URLError)?.code != .cancelled else { return }
            mediaStatus = error.localizedDescription
        }
    }

    private func safeMediaFileName(_ source: String, fallbackExtension: String) -> String {
        let lastComponent = (source as NSString).lastPathComponent
        let sanitized = lastComponent.filter { character in
            character != "/"
                && character != "\\"
                && character.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
        }
        return sanitized.nilIfEmpty.map { prefixByUTF16Units($0, limit: 150) }
            ?? "climbing-beta.\(fallbackExtension)"
    }

    private func cleanupPendingMediaFile() {
        guard let pendingMediaFile else { return }
        try? FileManager.default.removeItem(at: pendingMediaFile)
        self.pendingMediaFile = nil
    }

    private func cancelMediaTransfer() {
        mediaTask?.cancel()
        mediaTask = nil
        cleanupPendingMediaFile()
    }

    private func goalKindTitle(_ kind: ClimbingGoalKind) -> String {
        kind == .project ? "Climb project" : enumTitle(kind.rawValue)
    }

    private func goalStatusTitle(_ status: ClimbingGoalStatus) -> String {
        guard value.kind == .project else { return enumTitle(status.rawValue) }
        return switch status {
        case .active: "Projecting"
        case .paused: "Paused"
        case .completed: "Sent"
        }
    }

    private var allowedProjectGradeSystems: [GradeSystem] {
        GradeSystem.allCases.filter { projectGradeFits($0, discipline: value.discipline) }
    }

    private func projectGradeFits(_ system: GradeSystem, discipline: ClimbDiscipline?) -> Bool {
        switch discipline {
        case .boulder: ![.yds, .french, .uiaa, .uk].contains(system)
        case .route: ![.vScale, .font].contains(system)
        case nil: true
        }
    }

    private func updateProjectDiscipline(_ discipline: ClimbDiscipline?) {
        value.discipline = discipline
    }

    private func configure(for kind: ClimbingGoalKind) {
        if kind == .consistency {
            hasStartDate = true
            hasTargetDate = true
            hasSessionTarget = true
            value.startDate = value.startDate ?? WorkspaceFormat.dayKey()
            value.targetDate = value.targetDate ?? shiftDay(WorkspaceFormat.dayKey(), by: 28)
            value.sessionTarget = value.sessionTarget ?? 8
        } else {
            hasSessionTarget = false
        }

        if kind == .project {
            hasStartDate = false
            value.environment = value.environment ?? .indoor
            updateProjectDiscipline(value.discipline ?? .boulder)
            value.attempts = value.attempts ?? 0
        }
    }

    private func normalized(
        _ source: ClimbingGoal,
        includesStartDate: Bool,
        includesTargetDate: Bool,
        includesSessionTarget: Bool,
        updatedAt: String
    ) -> ClimbingGoal {
        var result = source
        result.title = result.title.trimmingCharacters(in: .whitespacesAndNewlines)
        result.description = result.description.trimmingCharacters(in: .whitespacesAndNewlines)
        result.nextStep = result.nextStep.trimmingCharacters(in: .whitespacesAndNewlines)
        result.venue = result.venue?.nilIfEmpty
        result.grade = result.grade?.nilIfEmpty
        if !includesStartDate || result.kind == .project { result.startDate = nil }
        if !includesTargetDate { result.targetDate = nil }
        if result.kind != .consistency || !includesSessionTarget { result.sessionTarget = nil }
        if result.kind == .project {
            result.attempts = result.attempts ?? 0
            result.routineId = nil
            if result.discipline == .boulder {
                result.ropeStyle = nil
            }
            if let system = result.gradeSystem,
               !projectGradeFits(system, discipline: result.discipline) {
                result.gradeSystem = nil
                result.grade = nil
            }
        } else {
            result.venue = nil
            result.environment = nil
            result.discipline = nil
            result.ropeStyle = nil
            result.gradeSystem = nil
            result.grade = nil
            result.attempts = nil
            if result.kind != .training { result.routineId = nil }
        }
        result.updatedAt = updatedAt
        return result
    }

    private func normalized() -> ClimbingGoal {
        normalized(
            value,
            includesStartDate: hasStartDate,
            includesTargetDate: hasTargetDate,
            includesSessionTarget: hasSessionTarget,
            updatedAt: WorkspaceFormat.timestamp()
        )
    }

    private var goalIsValid: Bool {
        guard value.title.nilIfEmpty != nil else { return false }
        guard (value.gradeSystem == nil) == (value.grade?.nilIfEmpty == nil) else { return false }
        if value.kind == .project {
            guard value.environment != nil, value.discipline != nil else { return false }
            if let attempts = value.attempts, !(0...9999).contains(attempts) { return false }
        }
        if value.kind == .consistency {
            guard hasStartDate, hasTargetDate, hasSessionTarget,
                  let start = value.startDate, let end = value.targetDate,
                  value.sessionTarget != nil, end >= start else { return false }
        }
        return true
    }

    private func save() {
        let result = normalized()
        Task { if await store.upsertClimbingGoal(result, openingState: openingState) { dismiss() } }
    }

    private func archive() {
        var result = normalized()
        result.archivedAt = WorkspaceFormat.timestamp()
        Task { if await store.upsertClimbingGoal(result, openingState: openingState) { dismiss() } }
    }
}

private struct ClimbingGoalLinkDraft: Identifiable {
    let id = UUID()
    let goalId: String
}

private struct ClimbingGoalLinkEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let draft: ClimbingGoalLinkDraft
    @State private var label = ""
    @State private var urlText = ""
    @State private var saving = false

    private var normalizedURL: URL? {
        let value = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: value),
              components.scheme == "https",
              components.host != nil else { return nil }
        return components.url
    }

    private var normalizedLabel: String? {
        if let value = label.nilIfEmpty { return prefixByUTF16Units(value, limit: 120) }
        return normalizedURL?.host.map { prefixByUTF16Units($0, limit: 120) }
    }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .climbing)
                Section {
                    TextField("Label", text: $label)
                    TextField("https://…", text: $urlText)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Link")
                } footer: {
                    Text("Use a secure web link to a route page, shared album, or other beta reference.")
                }
            }
            .navigationTitle("Add link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { save() }
                        .disabled(normalizedURL == nil || normalizedLabel == nil || saving)
                }
            }
            .interactiveDismissDisabled(saving || label.nilIfEmpty != nil || urlText.nilIfEmpty != nil)
        }
    }

    private func save() {
        guard let url = normalizedURL, let label = normalizedLabel else { return }
        saving = true
        let reference = ClimbingGoalReference(
            id: UUID().uuidString.lowercased(),
            goalId: draft.goalId,
            kind: .link,
            label: label,
            url: url.absoluteString,
            fileName: nil,
            mimeType: nil,
            byteSize: nil,
            createdAt: WorkspaceFormat.timestamp()
        )
        Task {
            if await store.addClimbingGoalLink(reference) { dismiss() }
            saving = false
        }
    }
}

private struct ClimbingMediaTransfer: Transferable, Sendable {
    let file: URL
    let fileName: String
    let kind: ClimbingGoalReferenceKind

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            try copy(received, kind: .image)
        }
        FileRepresentation(importedContentType: .movie) { received in
            try copy(received, kind: .video)
        }
    }

    private static func copy(
        _ received: ReceivedTransferredFile,
        kind: ClimbingGoalReferenceKind
    ) throws -> ClimbingMediaTransfer {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("WorkspaceMediaPicker", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let sourceName = received.file.lastPathComponent
        let fileExtension = received.file.pathExtension
        let suffix = fileExtension.isEmpty ? "" : ".\(fileExtension)"
        let destination = directory.appendingPathComponent(UUID().uuidString.lowercased() + suffix)
        try FileManager.default.copyItem(at: received.file, to: destination)
        return ClimbingMediaTransfer(file: destination, fileName: sourceName, kind: kind)
    }
}

private struct ClimbingGoalMediaPreview: Identifiable {
    var id: String { reference.id }
    let reference: ClimbingGoalReference
    let file: URL
}

private struct ClimbingGoalMediaPreviewView: View {
    @Environment(\.dismiss) private var dismiss
    let preview: ClimbingGoalMediaPreview
    @State private var player: AVPlayer?
    @State private var image: UIImage?

    var body: some View {
        NavigationStack {
            Group {
                if preview.reference.kind == .image {
                    if let image {
                        ScrollView([.horizontal, .vertical]) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    } else {
                        ProgressView()
                    }
                } else if let player {
                    VideoPlayer(player: player)
                } else {
                    ProgressView()
                }
            }
            .background(Color.black)
            .navigationTitle(preview.reference.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .onAppear {
                if preview.reference.kind == .image {
                    image = UIImage(contentsOfFile: preview.file.path)
                } else {
                    player = AVPlayer(url: preview.file)
                }
            }
            .onDisappear {
                player?.pause()
                try? FileManager.default.removeItem(at: preview.file)
            }
        }
    }
}

private struct ClimbingRoutineEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let original: ClimbingRoutine
    @State private var value: ClimbingRoutine
    @State private var openingState: ClimbingState
    @State private var wasNew: Bool
    @State private var confirmArchive = false

    init(draft: ClimbingEditorDraft<ClimbingRoutine>) {
        original = draft.value
        _value = State(initialValue: draft.value)
        _openingState = State(initialValue: draft.openingState)
        _wasNew = State(initialValue: draft.isNew)
    }

    private var isNew: Bool { wasNew }
    private var dirty: Bool { value != original }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .climbing)
                ClimbingEditorConflictSection()
                Section("Routine") {
                    TextField("Name", text: $value.title)
                    Picker("Focus", selection: $value.focus) {
                        ForEach(RoutineFocus.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                    TextField("Purpose or coaching cues", text: $value.description, axis: .vertical).lineLimit(2...6)
                    Toggle("Estimated duration", isOn: Binding(
                        get: { value.estimatedMinutes != nil },
                        set: { value.estimatedMinutes = $0 ? 45 : nil }
                    ))
                    if value.estimatedMinutes != nil {
                        Stepper("Duration · \(minutesLabel(value.estimatedMinutes ?? 45))", value: Binding(get: { value.estimatedMinutes ?? 45 }, set: { value.estimatedMinutes = $0 }), in: 5...360, step: 5)
                    }
                }
                Section("Steps") {
                    ForEach($value.steps) { $step in
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("Step name", text: $step.name)
                            TextField("Prescription", text: $step.prescription)
                            HStack {
                                TextField("Rest", text: $step.rest)
                                TextField("Notes", text: $step.notes)
                            }
                        }
                        .padding(.vertical, 3)
                    }
                    .onDelete { value.steps.remove(atOffsets: $0) }
                    Button { value.steps.append(.new()) } label: { Label("Add step", systemImage: "plus") }
                }
                if !isNew {
                    Section {
                        Button("Archive routine", role: .destructive) { confirmArchive = true }
                            .disabled(store.climbingConflict != nil)
                    }
                }
            }
            .navigationTitle(isNew ? "New routine" : "Edit routine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(!routineIsValid || store.climbingConflict != nil)
                }
            }
            .interactiveDismissDisabled(dirty)
            .confirmationDialog("Archive this routine?", isPresented: $confirmArchive, titleVisibility: .visible) {
                Button("Archive routine", role: .destructive) { archive() }
                    .disabled(store.climbingConflict != nil)
                Button("Keep routine", role: .cancel) { }
            } message: { Text("Sessions and plans keep the saved version of this routine.") }
        }
    }

    private func normalized() -> ClimbingRoutine {
        var result = value
        result.title = result.title.trimmingCharacters(in: .whitespacesAndNewlines)
        result.description = result.description.trimmingCharacters(in: .whitespacesAndNewlines)
        if !isNew && result != original { result.version = max(original.version + 1, result.version) }
        result.updatedAt = WorkspaceFormat.timestamp()
        return result
    }

    private var routineIsValid: Bool {
        value.title.nilIfEmpty != nil && !value.steps.isEmpty && value.steps.allSatisfy {
            $0.name.nilIfEmpty != nil && $0.prescription.nilIfEmpty != nil
        }
    }

    private func save() {
        let result = normalized()
        Task { if await store.upsertClimbingRoutine(result, openingState: openingState) { dismiss() } }
    }

    private func archive() {
        var result = normalized()
        result.archived = true
        Task { if await store.upsertClimbingRoutine(result, openingState: openingState) { dismiss() } }
    }
}

// MARK: - Health

private struct MobileHealthDay {
    let steps: Double?
    let sleepMinutes: Double?
    let restingHeartRate: Double?
    let weightKg: Double?
}

private func preferredHealthDay(
    on day: String,
    localSnapshot: HealthSnapshot?,
    remoteSnapshot: PhoneHealthSnapshot?
) -> MobileHealthDay? {
    let local = localSnapshot?.days.first(where: { $0.date == day })
    let remote = remoteSnapshot?.days.first(where: { $0.date == day })
    if local != nil || remote != nil {
        return MobileHealthDay(
            steps: local?.steps ?? remote?.steps,
            sleepMinutes: local?.sleepMinutes ?? remote?.sleepMinutes,
            restingHeartRate: local?.restingHeartRate ?? remote?.restingHeartRate,
            weightKg: local?.weightKg ?? remote?.weightKg
        )
    }
    return nil
}

struct HealthWorkspaceView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Binding var selectedDay: Date
    let openSettings: () -> Void

    @State private var weightToReview: WeightCommand?

    private var day: String { WorkspaceFormat.dayKey(selectedDay) }
    private var healthDay: MobileHealthDay? {
        preferredHealthDay(
            on: day,
            localSnapshot: store.healthSnapshot,
            remoteSnapshot: store.healthView?.snapshot
        )
    }
    private var workouts: [UnifiedHealthWorkout] {
        preferredHealthWorkouts(
            on: day,
            localSnapshot: store.healthSnapshot,
            remoteSnapshot: store.healthView?.snapshot
        ).sorted { $0.start < $1.start }
    }
    private var needsMac: Bool {
        !store.managesAppleHealth && !store.isOnline && store.healthView == nil
    }

    var body: some View {
        List {
            if needsMac {
                MacRequiredSection(
                    detail: "Health summaries load from Workspace on your Mac and are not saved for offline use on this iPad.",
                    openSettings: openSettings
                )
            } else {
                WorkspaceStatusBanner(openSettings: openSettings, errorArea: .health, requiresFullWorkspace: false)
                Section { WeekDayPicker(selection: $selectedDay) }

                Section {
                    if let healthDay {
                        HealthMetricRow(icon: "figure.walk", color: .green, title: "Steps", value: healthDay.steps.map { Int($0).formatted() } ?? "—")
                        HealthMetricRow(icon: "bed.double.fill", color: .indigo, title: "Sleep", value: healthDay.sleepMinutes.map { minutesLabel(Int($0.rounded())) } ?? "—")
                        HealthMetricRow(icon: "heart.fill", color: .pink, title: "Resting heart rate", value: healthDay.restingHeartRate.map { "\(Int($0.rounded())) bpm" } ?? "—")
                        HealthMetricRow(icon: "scalemass.fill", color: .blue, title: "Weight", value: healthDay.weightKg.map(weightLabel) ?? "—")
                    } else {
                        EmptyRow(
                            icon: "heart.text.square",
                            title: "No accessible readings",
                            detail: store.managesAppleHealth
                                ? "Use Settings to update Apple Health, or choose another day."
                                : "Sync with your Mac to update the health summary collected by your iPhone."
                        )
                    }
                } header: {
                    Text("Daily snapshot")
                } footer: {
                    if !store.managesAppleHealth {
                        Text("Read-only on iPad. Apple Health collection and writes stay on your iPhone.")
                    }
                }

                Section("Workouts") {
                    if workouts.isEmpty {
                        Text("No accessible workouts on this day.").foregroundStyle(.secondary)
                    } else {
                        ForEach(workouts) { workout in
                            HStack(spacing: 12) {
                                Image(systemName: workout.activity == "climbing" ? "mountain.2.fill" : "figure.run")
                                    .foregroundStyle(workout.activity == "climbing" ? Color.orange : Color.blue)
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(workout.name).font(.headline)
                                    Text("\(WorkspaceFormat.timeLabel(workout.start, in: workout.timeZone)) · \(minutesLabel(Int(workout.minutes.rounded()))) · \(workout.source)")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                if store.managesAppleHealth && !store.commands.isEmpty {
                    Section {
                        ForEach(store.commands) { command in
                            Button { weightToReview = command } label: {
                                HStack {
                                    Label(weightLabel(command.kg), systemImage: "scalemass")
                                    Spacer()
                                    Text(command.measuredAt.formatted(date: .abbreviated, time: .shortened)).foregroundStyle(.secondary)
                                }
                            }
                        }
                    } header: {
                        Text("Waiting for review")
                    } footer: {
                        Text("Workspace never writes a measurement to Apple Health without your confirmation on this iPhone.")
                    }
                }
            }
        }
        .navigationTitle("Health")
        .task { await store.load(.health) }
        .confirmationDialog(
            weightToReview.map { "Save \(weightLabel($0.kg)) to Apple Health?" } ?? "Save this measurement?",
            isPresented: Binding(get: { weightToReview != nil }, set: { if !$0 { weightToReview = nil } }),
            titleVisibility: .visible
        ) {
            Button("Save to Apple Health") {
                guard let command = weightToReview else { return }
                weightToReview = nil
                Task { await store.confirmWeight(command) }
            }
            Button("Not now", role: .cancel) { weightToReview = nil }
        } message: {
            if let command = weightToReview {
                Text("Measured \(command.measuredAt.formatted(date: .abbreviated, time: .shortened)). The app will save this as a user-entered body mass measurement.")
            }
        }
    }
}

private struct HealthMetricRow: View {
    let icon: String
    let color: Color
    let title: String
    let value: String
    var body: some View {
        LabeledContent {
            Text(value).font(.body.weight(.semibold))
        } label: {
            Label(title, systemImage: icon).foregroundStyle(color)
        }
    }
}

private struct HealthHistoryImportView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var from = Calendar.current.date(byAdding: .year, value: -1, to: Date()) ?? Date()
    @State private var confirmImport = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Start date", selection: $from, in: ...Date(), displayedComponents: .date)
                } header: {
                    Text("Import range")
                } footer: {
                    Text("Sleep stages and daily context are read from this iPhone in 30-day batches. Completed batches stay saved if you stop.")
                }
                Section {
                    if store.importingHistory {
                        ProgressView()
                        Text(store.sleepStatus).font(.subheadline).foregroundStyle(.secondary)
                        Button("Stop after this batch", role: .destructive) { store.cancelHealthHistory() }
                    } else {
                        Button("Review import") { confirmImport = true }
                    }
                }
            }
            .navigationTitle("Sleep history")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .interactiveDismissDisabled(store.importingHistory)
            .confirmationDialog("Import sleep history from \(from.formatted(date: .abbreviated, time: .omitted))?", isPresented: $confirmImport, titleVisibility: .visible) {
                Button("Start import") { Task { await store.importHealthHistory(from: from) } }
                Button("Keep editing", role: .cancel) { }
            } message: { Text("This can take several minutes. Keep the iPhone unlocked and near the paired Mac.") }
        }
    }
}

// MARK: - More

struct MoreView: View {
    @EnvironmentObject private var store: WorkspaceStore

    var body: some View {
        List {
            Section("Workspace") {
                NavigationLink(value: MoreRoute.mail) {
                    MoreDestinationRow(icon: "envelope.fill", color: .blue, title: "Mail", detail: mailDetail)
                }
                NavigationLink(value: MoreRoute.finance) {
                    MoreDestinationRow(icon: "wallet.bifold.fill", color: .green, title: "Finances", detail: financeDetail)
                }
                NavigationLink(value: MoreRoute.writing) {
                    MoreDestinationRow(icon: "square.and.pencil", color: .purple, title: "Writing", detail: writingDetail)
                }
                NavigationLink(value: MoreRoute.chess) {
                    MoreDestinationRow(icon: "checkerboard.rectangle", color: .indigo, title: "Chess", detail: chessDetail)
                }
            }
            Section("App") {
                NavigationLink(value: MoreRoute.settings) {
                    MoreDestinationRow(icon: "gearshape.fill", color: .gray, title: "Settings", detail: settingsDetail)
                }
            }
        }
        .navigationTitle("More")
    }

    private var financeDetail: String {
        guard store.finance.configured else { return "No finance data yet" }
        return "\(store.finance.banks.count) institutions · \(store.finance.transactions.count) recent transactions"
    }
    private var mailDetail: String {
        let gmail = store.integrations.gmail
        guard gmail.connected else { return "Mail unavailable" }
        let unread = gmail.unreadCount == 1 ? "1 unread recently" : "\(gmail.unreadCount) unread recently"
        return [gmail.account?.nilIfEmpty, unread].compactMap { $0 }.joined(separator: " · ")
    }
    private var writingDetail: String {
        guard store.writing.available else { return "Site entries unavailable" }
        return "\(store.writing.drafts.count) drafts · \(store.writing.entries.count) site entries"
    }
    private var chessDetail: String {
        let summary = store.chess.summary
        if summary.reviewsDue > 0 {
            return summary.reviewsDue == 1 ? "1 review due" : "\(summary.reviewsDue) reviews due"
        }
        return summary.totalSteps > 0
            ? "\(summary.stepsCovered) of \(summary.totalSteps) steps covered"
            : "Study and review your repertoire"
    }
    private var settingsDetail: String {
        let count = [store.integrations.google.connected, store.integrations.gmail.connected, store.integrations.todoist.connected].filter { $0 }.count
        let device = store.hasWorkspaceAccess ? "Device paired" : "Setup needed"
        return "\(count) of 3 services · \(device)"
    }
}

private struct MoreDestinationRow: View {
    let icon: String
    let color: Color
    let title: String
    let detail: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(color).frame(width: 26)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).foregroundStyle(.primary)
                Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
    }
}

// MARK: - Chess

private struct TabletChessWorkspaceView: View {
    @EnvironmentObject private var store: WorkspaceStore
    let openSettings: () -> Void

    @State private var reviewCard: ChessReviewCard?

    var body: some View {
        List {
            WorkspaceStatusBanner(openSettings: openSettings, errorArea: .chess)

            if store.hasWorkspaceAccess {
                Section("Study progress") {
                    LabeledContent("Reviews due", value: store.chess.summary.reviewsDue.formatted())
                    LabeledContent(
                        "Steps covered",
                        value: "\(store.chess.summary.stepsCovered) of \(store.chess.summary.totalSteps)"
                    )
                    if let accuracy = store.chess.summary.recentReviewAccuracy {
                        LabeledContent(
                            "Recent accuracy",
                            value: accuracy.formatted(.percent.precision(.fractionLength(0)))
                        )
                    }
                    if let next = store.chess.summary.nextDueAt,
                       store.chess.summary.reviewsDue == 0 {
                        LabeledContent("Next review", value: displayTimestamp(next))
                    }
                }

                Section {
                    if let first = store.chess.reviewQueue.first {
                        Button {
                            reviewCard = first
                        } label: {
                            Label(
                                store.chess.summary.reviewsDue == 1
                                    ? "Start 1 review"
                                    : "Start \(store.chess.summary.reviewsDue) reviews",
                                systemImage: "play.fill"
                            )
                        }
                        .disabled(!store.chess.capability.canWrite || store.isLoading(.chess))
                    } else {
                        EmptyRow(
                            icon: "checkmark.seal.fill",
                            title: "Reviews are clear",
                            detail: store.chess.summary.nextDueAt.map {
                                "The next card is due \(displayTimestamp($0))."
                            } ?? "New lesson steps will appear here for review."
                        )
                    }
                } header: {
                    Text("Review")
                } footer: {
                    if !store.chess.reviewQueue.isEmpty {
                        Text("Choose a move on the board, then explain why it works. Workspace grades and schedules each card on your Mac.")
                    }
                }

                Section("Courses") {
                    if store.chess.catalog.courses.isEmpty {
                        EmptyRow(
                            icon: "checkerboard.rectangle",
                            title: store.isLoading(.chess) ? "Loading the chess catalog" : "No chess catalog loaded",
                            detail: store.isPaired
                                ? "Refresh after the paired Mac finishes loading Chess."
                                : "Pair with your Mac to load Chess."
                        )
                    } else {
                        ForEach(store.chess.catalog.courses) { course in
                            let progress = courseProgress(course)
                            NavigationLink {
                                ChessCourseDetailView(course: course)
                            } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(course.title)
                                            .font(.headline)
                                            .foregroundStyle(.primary)
                                        Spacer()
                                        Text(course.level)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(course.description)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                    ProgressView(
                                        value: progress.total == 0
                                            ? 0
                                            : Double(progress.covered) / Double(progress.total)
                                    )
                                    .tint(WorkspaceBrand.signal)
                                    Text("\(progress.covered) of \(progress.total) trainer steps covered")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Chess")
        .scrollContentBackground(.hidden)
        .background(WorkspaceBrand.canvas)
        .task {
            guard store.hasWorkspaceAccess else { return }
            await store.load(.chess)
        }
        .refreshable {
            guard store.hasWorkspaceAccess else { return }
            await store.load(.chess, force: true)
        }
        .sheet(item: $reviewCard) { card in
            ChessReviewSessionView(firstCard: card)
        }
    }

    private func courseProgress(_ course: ChessCourse) -> (covered: Int, total: Int) {
        let lessonIds = Set(course.lessonIds)
        let totalIds = Set(
            store.chess.catalog.lessons
                .filter { $0.courseId == course.id && lessonIds.contains($0.id) }
                .flatMap { lesson in lesson.segments.flatMap { $0.steps ?? [] } }
                .map(\.id)
        )
        let coveredIds = Set(
            store.chess.state.progress
                .filter { $0.courseId == course.id && lessonIds.contains($0.lessonId) }
                .flatMap(\.completedStepIds)
        )
        return (coveredIds.intersection(totalIds).count, totalIds.count)
    }
}

private struct CurrentChessLessonRoute: Hashable {
    let courseId: String
    let lessonId: String
}

struct ChessWorkspaceView: View {
    @EnvironmentObject private var store: WorkspaceStore
    let openSettings: () -> Void

    private var currentLesson: ChessLesson? {
        let summary = store.chess.summary
        guard let courseId = summary.currentCourseId, let lessonId = summary.currentLessonId else { return nil }
        return store.chess.catalog.lessons.first {
            $0.courseId == courseId && $0.id == lessonId
        }
    }
    private var currentCourse: ChessCourse? {
        guard let lesson = currentLesson else { return nil }
        return store.chess.catalog.courses.first { $0.id == lesson.courseId }
    }
    private var currentProgress: ChessLessonProgress? {
        guard let lesson = currentLesson else { return nil }
        return store.chess.state.progress.first {
            $0.courseId == lesson.courseId && $0.lessonId == lesson.id
        }
    }

    var body: some View {
        List {
            WorkspaceStatusBanner(openSettings: openSettings, errorArea: .chess)

            if store.hasWorkspaceAccess {
                if let currentLesson {
                    Section {
                        NavigationLink(value: CurrentChessLessonRoute(
                            courseId: currentLesson.courseId,
                            lessonId: currentLesson.id
                        )) {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(currentCourse?.title ?? "Current lesson")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.indigo)
                                Text(currentLesson.title)
                                    .font(.title3.weight(.semibold))
                                    .foregroundStyle(.primary)
                                ProgressView(value: lessonProgressValue(currentLesson))
                                    .tint(.indigo)
                                Text(lessonProgressLabel(currentLesson))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                } else if !store.connectionNeedsAttention {
                    Section {
                        EmptyRow(
                            icon: "checkerboard.rectangle",
                            title: store.isLoading(.chess) ? "Loading your lesson" : lessonEmptyTitle,
                            detail: store.isLoading(.chess)
                                ? "Workspace is checking the lesson position saved on your Mac."
                                : lessonEmptyDetail
                        )
                        if store.isLoading(.chess) {
                            ProgressView()
                        }
                    }
                }
            }
        }
        .navigationTitle("Lesson")
        .toolbar { CompanionSettingsToolbar(openSettings: openSettings) }
        .task {
            guard store.hasWorkspaceAccess else { return }
            await store.load(.chess)
        }
        .navigationDestination(for: CurrentChessLessonRoute.self) { route in
            if let lesson = store.chess.catalog.lessons.first(where: {
                $0.courseId == route.courseId && $0.id == route.lessonId
            }) {
                ChessLessonReaderView(lesson: lesson, showsReviews: false)
                    .id("\(route.courseId):\(route.lessonId)")
            } else {
                ContentUnavailableView(
                    "Lesson is unavailable",
                    systemImage: "checkerboard.rectangle",
                    description: Text("Return to the Lesson tab after Workspace refreshes from your Mac.")
                )
            }
        }
    }

    private func lessonProgressValue(_ lesson: ChessLesson) -> Double {
        let total = lesson.segments.flatMap { $0.steps ?? [] }.count
        guard total > 0 else { return 0 }
        return Double(min(currentProgress?.completedStepIds.count ?? 0, total)) / Double(total)
    }

    private var lessonEmptyTitle: String {
        store.loadedAreas.contains(.chess) ? "No recent lesson" : "Lesson unavailable"
    }

    private var lessonEmptyDetail: String {
        store.loadedAreas.contains(.chess)
            ? "Open a lesson in Workspace on your Mac and it will be ready to continue here."
            : "Sync with your Mac once to bring the current lesson to this device."
    }

    private func lessonProgressLabel(_ lesson: ChessLesson) -> String {
        let total = lesson.segments.flatMap { $0.steps ?? [] }.count
        let covered = min(currentProgress?.completedStepIds.count ?? 0, total)
        return "\(covered) of \(total) trainer steps covered"
    }
}

private struct ChessCourseDetailView: View {
    @EnvironmentObject private var store: WorkspaceStore
    let course: ChessCourse

    private var lessons: [ChessLesson] {
        course.lessonIds.compactMap { id in
            store.chess.catalog.lessons.first { $0.courseId == course.id && $0.id == id }
        }
    }

    var body: some View {
        List {
            Section {
                Text(course.description).foregroundStyle(.secondary)
                LabeledContent("Level", value: course.level)
            }
            Section("Lessons") {
                ForEach(lessons) { lesson in
                    NavigationLink {
                        ChessLessonReaderView(lesson: lesson)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(lesson.title).foregroundStyle(.primary)
                            Text(lessonProgressLabel(lesson))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle(course.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func lessonProgressLabel(_ lesson: ChessLesson) -> String {
        let total = lesson.segments.flatMap { $0.steps ?? [] }.count
        let covered = store.chess.state.progress
            .first { $0.courseId == course.id && $0.lessonId == lesson.id }?
            .completedStepIds.count ?? 0
        return "\(min(covered, total)) of \(total) trainer steps covered"
    }
}

private enum ChessLearnFeedbackKind {
    case idle
    case correct
    case incorrect
    case revealed
}

private struct ChessLessonServerSnapshot: Equatable {
    let revision: Int
    let progress: ChessLessonProgress?
}

private struct ChessLessonReaderView: View {
    @EnvironmentObject private var store: WorkspaceStore
    let lesson: ChessLesson
    let showsReviews: Bool

    @State private var initialized = false
    @State private var segmentIndex = 0
    @State private var stepIndexBySegment: [String: Int] = [:]
    @State private var completedStepIds: [String] = []
    @State private var boardFen = ""
    @State private var selectedFrom: String?
    @State private var moveUci: String?
    @State private var hintIndex = -1
    @State private var revealedMove: String?
    @State private var feedbackKind: ChessLearnFeedbackKind = .idle
    @State private var feedbackText = "Read the idea, then use the board when the lesson asks for a move."
    @State private var pendingProgress: ChessProgressRequest?
    @State private var touchedStepIds: [String] = []
    @State private var sessionRequest: ChessSessionRequest?
    @State private var sessionSaved = false
    @State private var reviewCard: ChessReviewCard?
    @State private var appliedServerProgress: ChessLessonProgress?

    private let startedAt = WorkspaceFormat.timestamp()

    init(lesson: ChessLesson, showsReviews: Bool = true) {
        self.lesson = lesson
        self.showsReviews = showsReviews
    }

    private var dueCards: [ChessReviewCard] {
        store.chess.reviewQueue.filter { $0.courseId == lesson.courseId && $0.lessonId == lesson.id }
    }

    private var currentSegment: ChessLessonSegment? {
        guard lesson.segments.indices.contains(segmentIndex) else { return nil }
        return lesson.segments[segmentIndex]
    }

    private var currentStep: ChessTrainerStep? {
        guard let segment = currentSegment, segment.type == .trainer, let steps = segment.steps else { return nil }
        let index = stepIndexBySegment[segment.id] ?? 0
        return steps.indices.contains(index) ? steps[index] : nil
    }

    private var allSteps: [ChessTrainerStep] {
        lesson.segments.flatMap { $0.steps ?? [] }
    }

    private var savedLessonProgress: ChessLessonProgress? {
        store.chess.state.progress.first {
            $0.courseId == lesson.courseId && $0.lessonId == lesson.id
        }
    }

    private var serverSnapshot: ChessLessonServerSnapshot {
        ChessLessonServerSnapshot(
            revision: store.chess.state.revision,
            progress: savedLessonProgress
        )
    }

    var body: some View {
        List {
            if !initialized {
                Section { ProgressView("Loading saved lesson position…") }
            } else if let segment = currentSegment {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Section \(segmentIndex + 1) of \(lesson.segments.count)")
                            Spacer()
                            Text("\(coveredCount) of \(allSteps.count) steps")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        ProgressView(value: lesson.segments.isEmpty ? 0 : Double(segmentIndex + 1) / Double(lesson.segments.count))
                            .tint(.indigo)
                    }
                    Menu {
                        ForEach(lesson.segments.indices, id: \.self) { index in
                            Button {
                                moveToSegment(index)
                            } label: {
                                if index == segmentIndex {
                                    Label(lesson.segments[index].title, systemImage: "checkmark")
                                } else {
                                    Text(lesson.segments[index].title)
                                }
                            }
                            .disabled(pendingProgress != nil || store.isLoading(.chess))
                        }
                    } label: {
                        Label("Choose lesson section", systemImage: "list.number")
                    }
                }

                Section {
                    ForEach(segment.body, id: \.self) { paragraph in
                        Text(paragraph).font(.subheadline)
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(segment.type == .trainer ? trainerSectionLabel(segment) : segment.type.rawValue.capitalized)
                            .font(.caption)
                        Text(segment.title)
                    }
                }

                if let step = currentStep {
                    Section {
                        Text(step.prompt).font(.headline)
                        ChessBoardView(
                            fen: boardFen,
                            orientation: step.boardOrientation ?? segment.boardOrientation ?? .white,
                            selectedFrom: $selectedFrom,
                            moveUci: $moveUci,
                            disabled: pendingProgress != nil || store.isLoading(.chess) || sessionSaved,
                            onMove: attemptMove
                        )
                        Label(feedbackText, systemImage: feedbackIcon)
                            .font(.subheadline)
                            .foregroundStyle(feedbackColor)
                        if hintIndex >= 0, step.hints.indices.contains(hintIndex) {
                            Label(step.hints[hintIndex], systemImage: "lightbulb.fill")
                                .font(.subheadline)
                                .foregroundStyle(.orange)
                        }
                        if let revealedMove {
                            LabeledContent("Lesson move", value: revealedMove.uppercased())
                        }
                        HStack {
                            Button(hintIndex < 0 ? "Hint" : "Another hint", systemImage: "lightbulb") {
                                revealHint()
                            }
                            .disabled(step.hints.isEmpty || hintIndex >= step.hints.count - 1 || pendingProgress != nil)
                            Spacer()
                            Button("Reveal", systemImage: "scope") {
                                revealLessonMove()
                            }
                            .disabled(revealedMove != nil || pendingProgress != nil)
                        }
                        Button("Reset position", systemImage: "arrow.counterclockwise") {
                            resetPosition(segment: segment, step: step)
                        }
                        .disabled(pendingProgress != nil)
                    } header: {
                        Text("Position")
                    } footer: {
                        Text("Tap your piece, then its destination. Legal moves that differ from the authored lesson move stay available to retry. Reveal counts as covered, not mastered.")
                    }
                } else {
                    Section("Position") {
                        ChessBoardView(
                            fen: boardFen,
                            orientation: segment.boardOrientation ?? .white,
                            selectedFrom: .constant(nil),
                            moveUci: .constant(nil),
                            disabled: true
                        )
                    }
                }

                EditorErrorSection(area: .chess)

                if let pendingProgress, store.areaErrors[.chess] != nil {
                    Section {
                        Button(store.chessProgressNeedsRebase ? "Retry with latest progress" : "Retry saved progress") {
                            retryProgress(pendingProgress)
                        }
                        .disabled(store.isLoading(.chess))
                    } footer: {
                        Text(store.chessProgressNeedsRebase
                            ? "The latest Mac revision is loaded. Your lesson position and covered steps are still here and will be saved as a new request."
                            : "Workspace will retry the identical request ID and lesson state, so an uncertain response cannot skip or duplicate progress.")
                    }
                }

                if sessionSaved {
                    Section {
                        Label("Lesson session saved", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                    }
                }

                Section {
                    HStack {
                        Button("Previous", systemImage: "chevron.left") {
                            moveToSegment(segmentIndex - 1)
                        }
                        .disabled(segmentIndex == 0 || pendingProgress != nil || store.isLoading(.chess) || sessionSaved)
                        Spacer()
                        Button(isFinalPosition ? "Finish lesson" : "Continue", systemImage: "chevron.right") {
                            advance()
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.indigo)
                        .disabled(!canAdvance || pendingProgress != nil || store.isLoading(.chess) || sessionSaved)
                    }
                }

                if showsReviews, let first = dueCards.first {
                    Section("Review") {
                        Button {
                            reviewCard = first
                        } label: {
                            Label(
                                dueCards.count == 1 ? "Review 1 due position" : "Review \(dueCards.count) due positions",
                                systemImage: "play.fill"
                            )
                        }
                        .disabled(pendingProgress != nil || store.isLoading(.chess))
                    }
                }
            }
        }
        .navigationTitle(lesson.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { initializeLesson() }
        .onChange(of: serverSnapshot) { _, snapshot in
            reconcileServerProgress(snapshot.progress)
        }
        .sheet(item: $reviewCard) { card in
            ChessReviewSessionView(firstCard: card)
        }
    }

    private var coveredCount: Int {
        Set(completedStepIds).intersection(Set(allSteps.map(\.id))).count
    }

    private var canAdvance: Bool {
        guard let step = currentStep else { return true }
        return completedStepIds.contains(step.id)
    }

    private var isFinalPosition: Bool {
        guard let segment = currentSegment else { return true }
        let finalSegment = segmentIndex == lesson.segments.count - 1
        guard segment.type == .trainer, let steps = segment.steps else { return finalSegment }
        return finalSegment && (stepIndexBySegment[segment.id] ?? 0) == steps.count - 1
    }

    private var feedbackColor: Color {
        switch feedbackKind {
        case .idle: .secondary
        case .correct: .green
        case .incorrect: .orange
        case .revealed: .indigo
        }
    }

    private var feedbackIcon: String {
        switch feedbackKind {
        case .idle: "circle.dashed"
        case .correct: "checkmark.circle.fill"
        case .incorrect: "exclamationmark.circle.fill"
        case .revealed: "scope"
        }
    }

    private func trainerSectionLabel(_ segment: ChessLessonSegment) -> String {
        let index = stepIndexBySegment[segment.id] ?? 0
        return "Practice \(index + 1) of \(segment.steps?.count ?? 0)"
    }

    private func initializeLesson() {
        guard !initialized else { return }
        applyServerProgress(savedLessonProgress)
        initialized = true
    }

    private func reconcileServerProgress(_ saved: ChessLessonProgress?) {
        guard initialized, pendingProgress == nil, sessionRequest == nil else { return }
        guard saved != appliedServerProgress else { return }
        guard localProgressMatches(appliedServerProgress) else { return }
        applyServerProgress(saved)
    }

    private func applyServerProgress(_ saved: ChessLessonProgress?) {
        let nextCompletedStepIds = saved?.completedStepIds ?? []
        var nextSegmentIndex = 0
        var nextStepIndexBySegment: [String: Int] = [:]

        if let saved,
           let index = lesson.segments.firstIndex(where: { $0.id == saved.currentSegmentId }) {
            nextSegmentIndex = index
            if let currentStepId = saved.currentStepId,
               let steps = lesson.segments[index].steps,
               let stepIndex = steps.firstIndex(where: { $0.id == currentStepId }) {
                nextStepIndexBySegment[lesson.segments[index].id] = stepIndex
            }
        }

        completedStepIds = nextCompletedStepIds
        segmentIndex = nextSegmentIndex
        stepIndexBySegment = nextStepIndexBySegment
        appliedServerProgress = saved

        let segment = lesson.segments.indices.contains(nextSegmentIndex) ? lesson.segments[nextSegmentIndex] : nil
        let step = segment?.steps.flatMap { steps in
            let index = nextStepIndexBySegment[segment?.id ?? ""] ?? 0
            return steps.indices.contains(index) ? steps[index] : nil
        }
        resetPosition(segment: segment, step: step)
    }

    private func localProgressMatches(_ saved: ChessLessonProgress?) -> Bool {
        let localSegmentId = currentSegment?.id
        let localStepId = currentStep?.id
        let localCompleted = Set(completedStepIds)

        if let saved {
            return localSegmentId == saved.currentSegmentId
                && localStepId == saved.currentStepId
                && localCompleted == Set(saved.completedStepIds)
        }

        let initialSegment = lesson.segments.first
        let initialStep = initialSegment?.type == .trainer ? initialSegment?.steps?.first : nil
        return localSegmentId == initialSegment?.id
            && localStepId == initialStep?.id
            && localCompleted.isEmpty
    }

    private func resetPosition(segment: ChessLessonSegment?, step: ChessTrainerStep?) {
        boardFen = step?.fen ?? segment?.fen ?? lesson.initialFen
        selectedFrom = nil
        moveUci = nil
        hintIndex = -1
        revealedMove = nil
        if let step, completedStepIds.contains(step.id) {
            feedbackKind = .idle
            feedbackText = "This step is covered. Try it again or continue when you are ready."
        } else {
            feedbackKind = .idle
            feedbackText = "Find the lesson move on the board."
        }
    }

    private func attemptMove(_ candidate: String) {
        guard pendingProgress == nil, let segment = currentSegment, let step = currentStep else { return }
        guard var position = ChessBoardPosition(fen: step.fen).applying(candidate) else {
            selectedFrom = nil
            moveUci = nil
            feedbackKind = .incorrect
            feedbackText = "That move is illegal in this position. Try another square."
            return
        }
        let normalized = candidate.lowercased()
        guard step.acceptedMoves.map({ $0.lowercased() }).contains(normalized) else {
            selectedFrom = nil
            moveUci = nil
            feedbackKind = .incorrect
            feedbackText = "\(normalized.uppercased()) is legal, but it is not the authored lesson move. Try the central idea again or use a hint."
            return
        }
        for reply in step.opponentReplies ?? [] {
            guard let replied = position.applying(reply.lowercased()) else { break }
            position = replied
        }
        boardFen = position.fen
        feedbackKind = .correct
        feedbackText = "\(normalized.uppercased()) is right. \(step.explanation)"
        complete(step, in: segment)
    }

    private func revealHint() {
        guard let step = currentStep, !step.hints.isEmpty else { return }
        hintIndex = min(hintIndex + 1, step.hints.count - 1)
    }

    private func revealLessonMove() {
        guard pendingProgress == nil, let segment = currentSegment, let step = currentStep,
              let solution = step.acceptedMoves.first else { return }
        boardFen = step.fen
        selectedFrom = String(solution.prefix(2))
        moveUci = solution.lowercased()
        revealedMove = solution
        feedbackKind = .revealed
        feedbackText = "The lesson move is \(solution.uppercased()). \(step.explanation)"
        complete(step, in: segment)
    }

    private func complete(_ step: ChessTrainerStep, in segment: ChessLessonSegment) {
        if !completedStepIds.contains(step.id) { completedStepIds.append(step.id) }
        if !touchedStepIds.contains(step.id) { touchedStepIds.append(step.id) }
        beginProgressSave(segment: segment, step: step, completed: completedStepIds)
    }

    private func moveToSegment(_ requestedIndex: Int) {
        guard pendingProgress == nil, !store.isLoading(.chess), !sessionSaved, !lesson.segments.isEmpty else { return }
        let nextIndex = max(0, min(lesson.segments.count - 1, requestedIndex))
        let segment = lesson.segments[nextIndex]
        let stepIndex = stepIndexBySegment[segment.id] ?? 0
        let step = segment.steps.flatMap { $0.indices.contains(stepIndex) ? $0[stepIndex] : nil }
        segmentIndex = nextIndex
        resetPosition(segment: segment, step: step)
        beginProgressSave(segment: segment, step: step, completed: completedStepIds)
    }

    private func advance() {
        guard pendingProgress == nil, let segment = currentSegment else { return }
        if let steps = segment.steps {
            let currentIndex = stepIndexBySegment[segment.id] ?? 0
            if currentIndex + 1 < steps.count {
                var indices = stepIndexBySegment
                indices[segment.id] = currentIndex + 1
                stepIndexBySegment = indices
                let nextStep = steps[currentIndex + 1]
                resetPosition(segment: segment, step: nextStep)
                beginProgressSave(segment: segment, step: nextStep, completed: completedStepIds)
                return
            }
        }
        if segmentIndex + 1 < lesson.segments.count {
            moveToSegment(segmentIndex + 1)
        } else {
            finishLesson()
        }
    }

    private func beginProgressSave(
        segment: ChessLessonSegment,
        step: ChessTrainerStep?,
        completed: [String]
    ) {
        guard pendingProgress == nil else { return }
        let request = ChessProgressRequest(
            revision: store.chess.state.revision,
            courseId: lesson.courseId,
            lessonId: lesson.id,
            currentSegmentId: segment.id,
            currentStepId: step?.id,
            completedStepIds: completed
        )
        pendingProgress = request
        saveProgress(request)
    }

    private func retryProgress(_ saved: ChessProgressRequest) {
        var request = saved
        if store.chessProgressNeedsRebase {
            request.revision = store.chess.state.revision
            request.requestId = UUID().uuidString.lowercased()
            pendingProgress = request
            store.prepareRebasedChessProgress()
        }
        saveProgress(request)
    }

    private func saveProgress(_ request: ChessProgressRequest) {
        Task {
            if await store.saveChessProgress(request), pendingProgress?.requestId == request.requestId {
                if let saved = savedLessonProgress,
                   saved.currentSegmentId == request.currentSegmentId,
                   saved.currentStepId == request.currentStepId,
                   Set(saved.completedStepIds) == Set(request.completedStepIds) {
                    appliedServerProgress = saved
                }
                pendingProgress = nil
            }
        }
    }

    private func finishLesson() {
        guard pendingProgress == nil else { return }
        if store.chessSessionNeedsRebase {
            sessionRequest = nil
            store.prepareRebasedChessSession()
        }
        let request = sessionRequest ?? ChessSessionRequest(
            revision: store.chess.state.revision,
            mode: .lesson,
            courseId: lesson.courseId,
            lessonId: lesson.id,
            startedAt: startedAt,
            endedAt: WorkspaceFormat.timestamp(),
            stepIds: touchedStepIds,
            reviewAttemptIds: []
        )
        sessionRequest = request
        Task {
            if await store.saveChessSession(request) != nil {
                sessionRequest = nil
                sessionSaved = true
            }
        }
    }
}

private struct ChessReviewSessionView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss

    private let courseId: String
    private let lessonId: String
    private let startedAt: String

    @State private var card: ChessReviewCard
    @State private var selectedFrom: String?
    @State private var moveUci: String?
    @State private var reasonChoiceId: String?
    @State private var pendingReview: ChessReviewRequest?
    @State private var result: ChessReviewResult?
    @State private var reviewedStepIds: [String] = []
    @State private var reviewAttemptIds: [String] = []
    @State private var sessionRequest: ChessSessionRequest?

    init(firstCard: ChessReviewCard) {
        courseId = firstCard.courseId
        lessonId = firstCard.lessonId
        startedAt = WorkspaceFormat.timestamp()
        _card = State(initialValue: firstCard)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(card.courseTitle).font(.caption.weight(.semibold)).foregroundStyle(.indigo)
                        Text(card.lessonTitle).font(.headline)
                        Text(card.prompt).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    ChessBoardView(
                        fen: card.fen,
                        orientation: card.boardOrientation,
                        selectedFrom: $selectedFrom,
                        moveUci: $moveUci,
                        disabled: pendingReview != nil || result != nil
                    )

                    if let moveUci {
                        HStack {
                            LabeledContent("Your move", value: moveUci.uppercased())
                            if pendingReview == nil, result == nil {
                                Button("Reset") {
                                    selectedFrom = nil
                                    self.moveUci = nil
                                }
                                .font(.caption.weight(.semibold))
                            }
                        }
                    }
                } footer: {
                    Text("Tap the piece you want to move, then its destination square. Promotions default to a queen.")
                }

                Section(card.question) {
                    ForEach(card.choices) { choice in
                        Button {
                            reasonChoiceId = choice.id
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: reasonChoiceId == choice.id ? "largecircle.fill.circle" : "circle")
                                    .foregroundStyle(reasonChoiceId == choice.id ? Color.indigo : Color.secondary)
                                Text(choice.text).foregroundStyle(.primary)
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(pendingReview != nil || result != nil)
                    }
                }

                EditorErrorSection(area: .chess)

                if let result {
                    Section {
                        Label(
                            result.grade == .good ? "Move and reason correct" : "Review this position again",
                            systemImage: result.grade == .good ? "checkmark.seal.fill" : "arrow.clockwise.circle.fill"
                        )
                        .foregroundStyle(result.grade == .good ? Color.green : Color.orange)
                        LabeledContent("Move", value: result.moveCorrect ? "Correct" : "Needs another look")
                        LabeledContent("Reason", value: result.reasonCorrect ? "Correct" : "Needs another look")
                        Text(card.step.explanation)
                            .font(.subheadline)
                        if result.grade == .again, let accepted = card.step.acceptedMoves.first {
                            Text("Study move: \(accepted.uppercased())")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        Text("Result")
                    } footer: {
                        Text("Scheduled for \(displayTimestamp(result.dueAt)).")
                    }

                    Section {
                        Button(sessionRequest == nil ? nextActionTitle : "Retry saving session") {
                            if let next = nextCard {
                                show(next)
                            } else {
                                Task { await finishSession() }
                            }
                        }
                        .disabled(store.isLoading(.chess))
                    }
                } else {
                    Section {
                        if pendingReview != nil, store.chessReviewNoLongerDue {
                            Button("Return to current review queue") {
                                store.dismissStaleChessReview()
                                dismiss()
                            }
                        } else {
                            Button(pendingReview == nil ? "Check answer" : "Retry saved answer") {
                                Task { await submitReview() }
                            }
                            .disabled(
                                moveUci == nil || reasonChoiceId == nil || store.isLoading(.chess)
                            )
                            if pendingReview != nil, store.chessReviewCanChangeAnswer {
                                Button("Change answer") {
                                    pendingReview = nil
                                    selectedFrom = nil
                                    moveUci = nil
                                    reasonChoiceId = nil
                                    store.changeChessReviewAnswer()
                                }
                            }
                        }
                    } footer: {
                        if pendingReview != nil, store.chessReviewNoLongerDue {
                            Text("This position was completed in another view and is no longer due. The current queue has been loaded from your Mac.")
                        } else if pendingReview != nil, store.chessReviewCanChangeAnswer {
                            Text("The Mac rejected this answer before saving it. Change the move or reason, then submit a new request.")
                        } else if pendingReview != nil {
                            Text("The same saved answer and request ID will be retried, so a dropped response cannot create a second attempt.")
                        }
                    }
                }
            }
            .navigationTitle("Chess review")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private var nextCard: ChessReviewCard? {
        store.chess.reviewQueue.first {
            $0.courseId == courseId && $0.lessonId == lessonId && $0.stepId != card.stepId
        }
    }

    private var nextActionTitle: String {
        nextCard == nil ? "Save session and finish" : "Next review"
    }

    private func submitReview() async {
        guard let moveUci, let reasonChoiceId else { return }
        let request = pendingReview ?? ChessReviewRequest(
            revision: store.chess.state.revision,
            courseId: card.courseId,
            lessonId: card.lessonId,
            stepId: card.stepId,
            moveUci: moveUci,
            reasonChoiceId: reasonChoiceId
        )
        pendingReview = request
        guard let saved = await store.submitChessReview(request) else { return }
        pendingReview = nil
        result = saved
        if !reviewedStepIds.contains(card.stepId) { reviewedStepIds.append(card.stepId) }
        if !reviewAttemptIds.contains(saved.attemptId) { reviewAttemptIds.append(saved.attemptId) }
    }

    private func show(_ next: ChessReviewCard) {
        card = next
        selectedFrom = nil
        moveUci = nil
        reasonChoiceId = nil
        pendingReview = nil
        result = nil
    }

    private func finishSession() async {
        guard !reviewAttemptIds.isEmpty else {
            dismiss()
            return
        }
        if store.chessSessionNeedsRebase {
            sessionRequest = nil
            store.prepareRebasedChessSession()
        }
        let request = sessionRequest ?? ChessSessionRequest(
            revision: store.chess.state.revision,
            mode: .review,
            courseId: courseId,
            lessonId: lessonId,
            startedAt: startedAt,
            endedAt: WorkspaceFormat.timestamp(),
            stepIds: reviewedStepIds,
            reviewAttemptIds: reviewAttemptIds
        )
        sessionRequest = request
        if await store.saveChessSession(request) != nil {
            sessionRequest = nil
            dismiss()
        }
    }
}

private struct ChessBoardPosition {
    var activeColor: ChessBoardOrientation
    var pieces: [String: Character]
    var castling: String
    var enPassant: String?
    var halfmoveClock: Int
    var fullmoveNumber: Int

    init(fen: String) {
        let fields = fen.split(separator: " ").map(String.init)
        activeColor = fields.indices.contains(1) && fields[1] == "b" ? .black : .white
        castling = fields.indices.contains(2) ? fields[2] : "-"
        enPassant = fields.indices.contains(3) && fields[3] != "-" ? fields[3] : nil
        halfmoveClock = fields.indices.contains(4) ? Int(fields[4]) ?? 0 : 0
        fullmoveNumber = fields.indices.contains(5) ? Int(fields[5]) ?? 1 : 1
        var parsed: [String: Character] = [:]
        let rows = fields.first?.split(separator: "/") ?? []
        for (rowIndex, row) in rows.prefix(8).enumerated() {
            var fileIndex = 0
            for symbol in row {
                if let count = symbol.wholeNumberValue {
                    fileIndex += count
                } else if fileIndex < 8 {
                    let file = Array("abcdefgh")[fileIndex]
                    parsed["\(file)\(8 - rowIndex)"] = symbol
                    fileIndex += 1
                }
            }
        }
        pieces = parsed
    }

    var fen: String {
        var rows: [String] = []
        for rank in (1...8).reversed() {
            var row = ""
            var empty = 0
            for file in Array("abcdefgh") {
                if let piece = pieces["\(file)\(rank)"] {
                    if empty > 0 { row += String(empty); empty = 0 }
                    row.append(piece)
                } else {
                    empty += 1
                }
            }
            if empty > 0 { row += String(empty) }
            rows.append(row)
        }
        return [
            rows.joined(separator: "/"),
            activeColor == .white ? "w" : "b",
            castling.isEmpty || castling == "-" ? "-" : castling,
            enPassant ?? "-",
            String(halfmoveClock),
            String(fullmoveNumber),
        ].joined(separator: " ")
    }

    func canMovePiece(on square: String) -> Bool {
        guard let piece = pieces[square] else { return false }
        return color(of: piece) == activeColor
    }

    func applying(_ uci: String) -> ChessBoardPosition? {
        let normalized = uci.lowercased()
        guard normalized.count == 4 || normalized.count == 5 else { return nil }
        let symbols = Array(normalized)
        let from = String(symbols[0...1])
        let to = String(symbols[2...3])
        let promotion = symbols.count == 5 ? symbols[4] : nil
        guard let source = coordinate(from), let target = coordinate(to),
              let piece = pieces[from], color(of: piece) == activeColor,
              pieces[to].map({ color(of: $0) != activeColor && $0.lowercased() != "k" }) ?? true,
              pseudoLegal(piece: piece, from: source, to: target, promotion: promotion) else { return nil }

        var next = self
        let captured = next.pieces[to]
        next.pieces.removeValue(forKey: from)

        if piece.lowercased() == "p", source.file != target.file, captured == nil {
            guard enPassant == to else { return nil }
            next.pieces.removeValue(forKey: square(file: target.file, rank: source.rank))
        }

        var movedPiece = piece
        if piece.lowercased() == "p", target.rank == 1 || target.rank == 8 {
            guard let promotion, "qrbn".contains(promotion) else { return nil }
            movedPiece = activeColor == .white ? Character(String(promotion).uppercased()) : promotion
        } else if promotion != nil {
            return nil
        }
        next.pieces[to] = movedPiece

        if piece.lowercased() == "k", abs(target.file - source.file) == 2 {
            let kingSide = target.file > source.file
            let rookFrom = square(file: kingSide ? 7 : 0, rank: source.rank)
            let rookTo = square(file: kingSide ? 5 : 3, rank: source.rank)
            guard let rook = next.pieces.removeValue(forKey: rookFrom) else { return nil }
            next.pieces[rookTo] = rook
        }

        next.removeCastlingRights(forMovedPiece: piece, from: from, captured: captured, at: to)
        if piece.lowercased() == "p", abs(target.rank - source.rank) == 2 {
            next.enPassant = square(file: source.file, rank: (source.rank + target.rank) / 2)
        } else {
            next.enPassant = nil
        }
        next.halfmoveClock = piece.lowercased() == "p" || captured != nil ? 0 : halfmoveClock + 1
        if activeColor == .black { next.fullmoveNumber += 1 }
        guard !next.kingIsAttacked(activeColor) else { return nil }
        next.activeColor = activeColor == .white ? .black : .white
        return next
    }

    private func pseudoLegal(
        piece: Character,
        from: (file: Int, rank: Int),
        to: (file: Int, rank: Int),
        promotion: Character?
    ) -> Bool {
        let dx = to.file - from.file
        let dy = to.rank - from.rank
        let targetSquare = square(file: to.file, rank: to.rank)
        switch piece.lowercased() {
        case "p":
            let direction = activeColor == .white ? 1 : -1
            let homeRank = activeColor == .white ? 2 : 7
            let promotionRank = activeColor == .white ? 8 : 1
            if to.rank == promotionRank {
                guard let promotion, "qrbn".contains(promotion) else { return false }
            } else if promotion != nil {
                return false
            }
            if dx == 0, dy == direction { return pieces[targetSquare] == nil }
            if dx == 0, dy == 2 * direction, from.rank == homeRank {
                return pieces[targetSquare] == nil
                    && pieces[square(file: from.file, rank: from.rank + direction)] == nil
            }
            if abs(dx) == 1, dy == direction {
                return pieces[targetSquare] != nil || enPassant == targetSquare
            }
            return false
        case "n":
            return (abs(dx), abs(dy)) == (1, 2) || (abs(dx), abs(dy)) == (2, 1)
        case "b":
            return abs(dx) == abs(dy) && pathIsClear(from: from, to: to)
        case "r":
            return (dx == 0 || dy == 0) && pathIsClear(from: from, to: to)
        case "q":
            return (dx == 0 || dy == 0 || abs(dx) == abs(dy)) && pathIsClear(from: from, to: to)
        case "k":
            if max(abs(dx), abs(dy)) == 1 { return true }
            return canCastle(from: from, to: to)
        default:
            return false
        }
    }

    private func canCastle(from: (file: Int, rank: Int), to: (file: Int, rank: Int)) -> Bool {
        guard from.file == 4, from.rank == (activeColor == .white ? 1 : 8),
              to.rank == from.rank, abs(to.file - from.file) == 2 else { return false }
        let kingSide = to.file > from.file
        let right: Character = activeColor == .white
            ? (kingSide ? "K" : "Q")
            : (kingSide ? "k" : "q")
        guard castling.contains(right) else { return false }
        let between = kingSide ? [5, 6] : [1, 2, 3]
        guard between.allSatisfy({ pieces[square(file: $0, rank: from.rank)] == nil }) else { return false }
        let rookSquare = square(file: kingSide ? 7 : 0, rank: from.rank)
        guard let rook = pieces[rookSquare], rook.lowercased() == "r", color(of: rook) == activeColor else { return false }
        let enemy: ChessBoardOrientation = activeColor == .white ? .black : .white
        let transit = kingSide ? [4, 5, 6] : [4, 3, 2]
        return transit.allSatisfy { !isAttacked(square(file: $0, rank: from.rank), by: enemy) }
    }

    private func pathIsClear(from: (file: Int, rank: Int), to: (file: Int, rank: Int)) -> Bool {
        let stepFile = (to.file - from.file).signum()
        let stepRank = (to.rank - from.rank).signum()
        var file = from.file + stepFile
        var rank = from.rank + stepRank
        while file != to.file || rank != to.rank {
            if pieces[square(file: file, rank: rank)] != nil { return false }
            file += stepFile
            rank += stepRank
        }
        return true
    }

    private func kingIsAttacked(_ color: ChessBoardOrientation) -> Bool {
        guard let king = pieces.first(where: {
            $0.value == (color == .white ? Character("K") : Character("k"))
        })?.key else { return true }
        let enemy: ChessBoardOrientation = color == .white ? .black : .white
        return isAttacked(king, by: enemy)
    }

    private func isAttacked(_ target: String, by attacker: ChessBoardOrientation) -> Bool {
        guard let destination = coordinate(target) else { return false }
        for (sourceSquare, piece) in pieces where color(of: piece) == attacker {
            guard let source = coordinate(sourceSquare) else { continue }
            let dx = destination.file - source.file
            let dy = destination.rank - source.rank
            switch piece.lowercased() {
            case "p":
                let direction = attacker == .white ? 1 : -1
                if abs(dx) == 1 && dy == direction { return true }
            case "n":
                if (abs(dx), abs(dy)) == (1, 2) || (abs(dx), abs(dy)) == (2, 1) { return true }
            case "b":
                if abs(dx) == abs(dy) && pathIsClear(from: source, to: destination) { return true }
            case "r":
                if (dx == 0 || dy == 0) && pathIsClear(from: source, to: destination) { return true }
            case "q":
                if (dx == 0 || dy == 0 || abs(dx) == abs(dy)) && pathIsClear(from: source, to: destination) { return true }
            case "k":
                if max(abs(dx), abs(dy)) == 1 { return true }
            default:
                continue
            }
        }
        return false
    }

    private mutating func removeCastlingRights(
        forMovedPiece piece: Character,
        from: String,
        captured: Character?,
        at target: String
    ) {
        var removed = Set<Character>()
        if piece == "K" { removed.formUnion(["K", "Q"]) }
        if piece == "k" { removed.formUnion(["k", "q"]) }
        if piece == "R", from == "a1" { removed.insert("Q") }
        if piece == "R", from == "h1" { removed.insert("K") }
        if piece == "r", from == "a8" { removed.insert("q") }
        if piece == "r", from == "h8" { removed.insert("k") }
        if captured == "R", target == "a1" { removed.insert("Q") }
        if captured == "R", target == "h1" { removed.insert("K") }
        if captured == "r", target == "a8" { removed.insert("q") }
        if captured == "r", target == "h8" { removed.insert("k") }
        castling = String(castling.filter { !removed.contains($0) })
        if castling.isEmpty { castling = "-" }
    }

    private func coordinate(_ square: String) -> (file: Int, rank: Int)? {
        let symbols = Array(square)
        guard symbols.count == 2,
              let file = Array("abcdefgh").firstIndex(of: symbols[0]),
              let rank = symbols[1].wholeNumberValue,
              (1...8).contains(rank) else { return nil }
        return (file, rank)
    }

    private func square(file: Int, rank: Int) -> String {
        guard (0..<8).contains(file), (1...8).contains(rank) else { return "" }
        return "\(Array("abcdefgh")[file])\(rank)"
    }

    private func color(of piece: Character) -> ChessBoardOrientation {
        piece.isUppercase ? .white : .black
    }
}

private struct ChessBoardView: View {
    let fen: String
    let orientation: ChessBoardOrientation
    @Binding var selectedFrom: String?
    @Binding var moveUci: String?
    let disabled: Bool
    var onMove: ((String) -> Void)? = nil

    private var position: ChessBoardPosition { ChessBoardPosition(fen: fen) }
    private var files: [Character] {
        let values = Array("abcdefgh")
        return orientation == .white ? values : values.reversed()
    }
    private var ranks: [Int] {
        orientation == .white ? Array((1...8).reversed()) : Array(1...8)
    }
    private var squares: [String] {
        ranks.flatMap { rank in files.map { "\($0)\(rank)" } }
    }

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size.width / 8
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(size), spacing: 0), count: 8), spacing: 0) {
                ForEach(squares, id: \.self) { square in
                    Button {
                        choose(square)
                    } label: {
                        ZStack {
                            squareColor(square)
                            if let piece = position.pieces[square],
                               let assetName = pieceAssetName(piece) {
                                Image(assetName)
                                    .renderingMode(.original)
                                    .resizable()
                                    .scaledToFit()
                                    .accessibilityHidden(true)
                            }
                            if selectedFrom == square || moveUci?.hasSuffix(square) == true {
                                Rectangle().stroke(Color.yellow, lineWidth: 3)
                            }
                        }
                        .frame(width: size, height: size)
                    }
                    .buttonStyle(.plain)
                    .disabled(disabled)
                    .accessibilityLabel(accessibilityLabel(square))
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(maxWidth: 560)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.35)))
    }

    private func choose(_ square: String) {
        guard !disabled else { return }
        if position.canMovePiece(on: square) {
            selectedFrom = square
            moveUci = nil
            return
        }
        guard let from = selectedFrom, from != square else {
            selectedFrom = nil
            moveUci = nil
            return
        }
        let promotion = promotionSuffix(from: from, to: square)
        let candidate = from + square + promotion
        moveUci = candidate
        onMove?(candidate)
    }

    private func promotionSuffix(from: String, to: String) -> String {
        guard let piece = position.pieces[from], piece.lowercased() == "p",
              to.last == "1" || to.last == "8" else { return "" }
        return "q"
    }

    private func squareColor(_ square: String) -> Color {
        let file = square.first.flatMap { Array("abcdefgh").firstIndex(of: $0) } ?? 0
        let rank = Int(String(square.last ?? "1")) ?? 1
        return (file + rank).isMultiple(of: 2)
            ? Color(red: 0.82, green: 0.86, blue: 0.78)
            : Color(red: 0.33, green: 0.45, blue: 0.35)
    }

    private func pieceAssetName(_ piece: Character) -> String? {
        switch piece {
        case "K": "ChessPieceWhiteKing"
        case "Q": "ChessPieceWhiteQueen"
        case "R": "ChessPieceWhiteRook"
        case "B": "ChessPieceWhiteBishop"
        case "N": "ChessPieceWhiteKnight"
        case "P": "ChessPieceWhitePawn"
        case "k": "ChessPieceBlackKing"
        case "q": "ChessPieceBlackQueen"
        case "r": "ChessPieceBlackRook"
        case "b": "ChessPieceBlackBishop"
        case "n": "ChessPieceBlackKnight"
        case "p": "ChessPieceBlackPawn"
        default: nil
        }
    }

    private func accessibilityLabel(_ square: String) -> String {
        guard let piece = position.pieces[square] else { return "Empty \(square)" }
        return "\(pieceName(piece)) on \(square)"
    }

    private func pieceName(_ piece: Character) -> String {
        let color = piece.isUppercase ? "White" : "Black"
        let name: String
        switch piece.lowercased() {
        case "k": name = "king"
        case "q": name = "queen"
        case "r": name = "rook"
        case "b": name = "bishop"
        case "n": name = "knight"
        default: name = "pawn"
        }
        return "\(color) \(name)"
    }
}

// MARK: - Mail

private struct MailComposeDraft: Identifiable {
    let id = UUID()
    var to = ""
    var cc = ""
    var bcc = ""
    var subject = ""
    var body = ""
    var replyToId: String?

    static func reply(to message: RemoteMail) -> MailComposeDraft {
        var draft = MailComposeDraft()
        draft.to = message.replyTo
        draft.subject = message.subject.lowercased().hasPrefix("re:")
            ? message.subject
            : "Re: \(message.subject.nilIfEmpty ?? "(no subject)")"
        draft.replyToId = message.id
        return draft
    }
}

private struct MailSubmissionPayload: Equatable {
    let to: [String]
    let cc: [String]
    let bcc: [String]
    let subject: String
    let body: String
    let replyToId: String?
}

private struct MailSubmissionAttempt {
    let payload: MailSubmissionPayload
    let requestId: String
}

private struct MailWorkspaceView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @State private var composeDraft: MailComposeDraft?
    @State private var messageToTrash: RemoteMail?
    @State private var search = ""

    private var messages: [RemoteMail] {
        store.integrations.messages
            .filter { message in
                search.isEmpty
                    || message.from.localizedCaseInsensitiveContains(search)
                    || message.subject.localizedCaseInsensitiveContains(search)
                    || message.snippet.localizedCaseInsensitiveContains(search)
            }
            .sorted { left, right in
                if left.receivedAt != right.receivedAt { return left.receivedAt > right.receivedAt }
                return left.id > right.id
            }
    }
    private var needsMac: Bool {
        !store.managesAppleHealth && !store.isOnline && !store.mailLoadedFromMac
    }

    var body: some View {
        List {
            EditorErrorSection(area: .integrations)

            if needsMac {
                MacRequiredSection(detail: "Mail loads from Workspace on your Mac and message previews are not saved for offline use on this iPad.")
            } else if !store.integrations.gmail.connected {
                Section {
                    Label("Mail is unavailable", systemImage: "envelope.badge")
                        .font(.headline)
                    Text("Review mail status in Settings, then finish authorization on your Mac.").font(.subheadline).foregroundStyle(.secondary)
                    NavigationLink("Open Settings", value: MoreRoute.settings)
                } header: {
                    Text("Personal Gmail")
                }
            } else {
                Section {
                    if messages.isEmpty {
                        EmptyRow(
                            icon: "envelope.open",
                            title: search.isEmpty ? "No messages in this view" : "No matching messages",
                            detail: search.isEmpty ? "New messages appear as Workspace updates." : "Try a sender, subject, or different phrase."
                        )
                    } else {
                        ForEach(messages) { message in
                            NavigationLink {
                                MailMessageView(messageID: message.id) { current in
                                    composeDraft = .reply(to: current)
                                }
                            } label: {
                                MailMessageRow(message: message)
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                Button {
                                    mutate(message, message.unread ? .read : .unread)
                                } label: {
                                    Label(message.unread ? "Read" : "Unread", systemImage: message.unread ? "envelope.open" : "envelope.badge")
                                }
                                .tint(.blue)
                                Button {
                                    mutate(message, message.starred ? .unstar : .star)
                                } label: {
                                    Label(message.starred ? "Unstar" : "Star", systemImage: message.starred ? "star.slash" : "star")
                                }
                                .tint(.yellow)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button {
                                    mutate(message, .archive)
                                } label: {
                                    Label("Archive", systemImage: "archivebox")
                                }
                                .tint(.indigo)
                                Button(role: .destructive) {
                                    messageToTrash = message
                                } label: {
                                    Label("Trash", systemImage: "trash")
                                }
                            }
                            .contextMenu {
                                Button {
                                    composeDraft = .reply(to: message)
                                } label: {
                                    Label("Reply", systemImage: "arrowshape.turn.up.left")
                                }
                                .disabled(message.replyTo.nilIfEmpty == nil)
                                if let url = safeGmailURL(message.url) {
                                    Link(destination: url) {
                                        Label("Open in Gmail", systemImage: "arrow.up.right.square")
                                    }
                                }
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text("Inbox")
                        Spacer()
                        Text(unreadLabel)
                    }
                }
            }
        }
        .navigationTitle("Mail")
        .searchable(text: $search, prompt: "Search loaded mail")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !needsMac {
                    Button {
                        composeDraft = MailComposeDraft()
                    } label: {
                        Label("Compose", systemImage: "square.and.pencil")
                    }
                    .disabled(!store.integrations.gmail.connected || store.isLoading(.integrations))
                }
            }
        }
        .task { await store.load(.integrations) }
        .sheet(item: $composeDraft) { draft in
            MailComposeView(draft: draft)
        }
        .confirmationDialog(
            messageToTrash.map { "Move “\($0.subject.nilIfEmpty ?? "this message")” to Trash?" } ?? "Move this message to Trash?",
            isPresented: Binding(get: { messageToTrash != nil }, set: { if !$0 { messageToTrash = nil } }),
            titleVisibility: .visible
        ) {
            Button("Move to Gmail Trash", role: .destructive) {
                guard let message = messageToTrash else { return }
                messageToTrash = nil
                mutate(message, .trash, confirm: true)
            }
            Button("Keep message", role: .cancel) { messageToTrash = nil }
        } message: {
            Text("This removes the message from the Inbox and moves it to Gmail Trash. Gmail controls when items in Trash are permanently deleted.")
        }
        .privacySensitive()
    }

    private var unreadLabel: String {
        let count = store.integrations.gmail.unreadCount
        return count == 1 ? "1 unread recently" : "\(count) unread recently"
    }

    private func mutate(_ message: RemoteMail, _ action: GmailMutationAction, confirm: Bool? = nil) {
        Task {
            await store.mutateGmail(GmailMutationRequest(
                id: message.id,
                version: message.version,
                action: action,
                confirm: confirm
            ))
        }
    }
}

private struct MailMessageRow: View {
    let message: RemoteMail

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(message.unread ? Color.blue : Color.clear)
                .frame(width: 8, height: 8)
                .padding(.top, 7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(message.from.nilIfEmpty ?? "Unknown sender")
                        .font(message.unread ? .subheadline.weight(.semibold) : .subheadline)
                        .lineLimit(1)
                    Spacer()
                    Text(displayTimestamp(message.receivedAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 5) {
                    Text(message.subject.nilIfEmpty ?? "(No subject)")
                        .font(message.unread ? .body.weight(.semibold) : .body)
                        .lineLimit(1)
                    if message.important {
                        Image(systemName: "tag.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    if message.starred {
                        Image(systemName: "star.fill")
                            .font(.caption2)
                            .foregroundStyle(.yellow)
                    }
                }
                Text(message.snippet.nilIfEmpty ?? "No preview available")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.unread ? "Unread" : "Read") message from \(message.from), subject \(message.subject)")
    }
}

private struct MailMessageView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let messageID: String
    let reply: (RemoteMail) -> Void
    @State private var confirmTrash = false

    private var message: RemoteMail? {
        store.integrations.messages.first { $0.id == messageID }
    }

    var body: some View {
        Group {
            if let message {
                List {
                    EditorErrorSection(area: .integrations)
                    Section {
                        LabeledContent("From", value: message.from.nilIfEmpty ?? "Unknown sender")
                        LabeledContent("Received", value: displayTimestamp(message.receivedAt))
                        LabeledContent("Status", value: message.unread ? "Unread" : "Read")
                    } header: {
                        Text(message.subject.nilIfEmpty ?? "(No subject)")
                    }
                    Section("Preview") {
                        Text(message.snippet.nilIfEmpty ?? "No preview is available for this message.")
                            .textSelection(.enabled)
                    }
                    Section("Actions") {
                        Button {
                            mutate(message, message.unread ? .read : .unread)
                        } label: {
                            Label(message.unread ? "Mark read" : "Mark unread", systemImage: message.unread ? "envelope.open" : "envelope.badge")
                        }
                        Button {
                            mutate(message, message.starred ? .unstar : .star)
                        } label: {
                            Label(message.starred ? "Remove star" : "Add star", systemImage: message.starred ? "star.slash" : "star")
                        }
                        Button {
                            Task {
                                if await store.mutateGmail(GmailMutationRequest(id: message.id, version: message.version, action: .archive)) {
                                    dismiss()
                                }
                            }
                        } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                        Button(role: .destructive) { confirmTrash = true } label: {
                            Label("Move to Trash", systemImage: "trash")
                        }
                    }
                    if let url = safeGmailURL(message.url) {
                        Section {
                            Link(destination: url) {
                                Label("Open full message in Gmail", systemImage: "arrow.up.right.square")
                            }
                        } footer: {
                            Text("Workspace keeps this view concise. Use Gmail for the full message, attachments, forwarding, and other mail tools.")
                        }
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            reply(message)
                        } label: {
                            Label("Reply", systemImage: "arrowshape.turn.up.left")
                        }
                        .disabled(store.isLoading(.integrations) || message.replyTo.nilIfEmpty == nil)
                    }
                }
            } else {
                ContentUnavailableView(
                    "Message no longer in Inbox",
                    systemImage: "tray",
                    description: Text("It may have been archived or moved to Trash. Use Settings to update the current Inbox.")
                )
            }
        }
        .navigationTitle("Message")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Move this message to Trash?", isPresented: $confirmTrash, titleVisibility: .visible) {
            Button("Move to Gmail Trash", role: .destructive) {
                guard let message else { return }
                Task {
                    if await store.mutateGmail(GmailMutationRequest(
                        id: message.id,
                        version: message.version,
                        action: .trash,
                        confirm: true
                    )) {
                        dismiss()
                    }
                }
            }
            Button("Keep message", role: .cancel) { }
        } message: {
            Text("Gmail controls when items in Trash are permanently deleted.")
        }
        .privacySensitive()
    }

    private func mutate(_ message: RemoteMail, _ action: GmailMutationAction) {
        Task {
            await store.mutateGmail(GmailMutationRequest(id: message.id, version: message.version, action: action))
        }
    }
}

private struct MailComposeView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var value: MailComposeDraft
    @State private var confirmSend = false
    @State private var lastSubmission: MailSubmissionAttempt?

    init(draft: MailComposeDraft) {
        _value = State(initialValue: draft)
    }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .integrations)
                Section {
                    mailAddressField("To", text: $value.to)
                        .disabled(value.replyToId != nil)
                    mailAddressField("Cc", text: $value.cc)
                    mailAddressField("Bcc", text: $value.bcc)
                } header: {
                    Text("Recipients")
                } footer: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Separate addresses with commas. Up to 20 per field and 32 total.")
                        if let recipientError {
                            Text(recipientError).foregroundStyle(.orange)
                        }
                    }
                }
                Section {
                    TextField("Subject", text: $value.subject, axis: .vertical)
                        .lineLimit(1...4)
                        .disabled(value.replyToId != nil)
                } header: {
                    Text("Subject")
                } footer: {
                    HStack {
                        if let subjectError {
                            Text(subjectError).foregroundStyle(.orange)
                        }
                        Spacer()
                        Text("\(subjectLength.formatted()) / 998")
                    }
                }
                Section {
                    TextEditor(text: $value.body)
                        .frame(minHeight: 220)
                } header: {
                    Text("Message")
                } footer: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(value.replyToId == nil ? "This sends from your connected personal Gmail account." : "This reply stays in the original Gmail thread.")
                            Spacer()
                            Text("\(bodyLength.formatted()) / 50,000")
                        }
                        if let bodyError {
                            Text(bodyError).foregroundStyle(.orange)
                        }
                    }
                }
            }
            .disabled(store.isLoading(.integrations))
            .navigationTitle(value.replyToId == nil ? "New Email" : "Reply")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(store.isLoading(.integrations))
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { confirmSend = true }
                        .fontWeight(.semibold)
                        .disabled(!canSend || store.isLoading(.integrations))
                }
            }
            .confirmationDialog("Send this email?", isPresented: $confirmSend, titleVisibility: .visible) {
                Button("Send email") { send() }
                Button("Keep editing", role: .cancel) { }
            } message: {
                Text("To: \(toRecipients.joined(separator: ", "))\nSubject: \(trimmedSubject)")
            }
            .interactiveDismissDisabled(store.isLoading(.integrations))
        }
        .privacySensitive()
        .overlay {
            if scenePhase != .active { WorkspacePrivacyCover() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { confirmSend = false }
        }
    }

    @ViewBuilder
    private func mailAddressField(_ label: String, text: Binding<String>) -> some View {
        LabeledContent(label) {
            TextField("email@example.com", text: text, axis: .vertical)
                .multilineTextAlignment(.trailing)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
        }
    }

    private var toRecipients: [String] { parseMailRecipients(value.to) }
    private var ccRecipients: [String] { parseMailRecipients(value.cc) }
    private var bccRecipients: [String] { parseMailRecipients(value.bcc) }
    private var trimmedSubject: String { value.subject.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var subjectLength: Int { trimmedSubject.utf16.count }
    private var bodyLength: Int { value.body.utf16.count }

    private var recipientError: String? {
        if toRecipients.isEmpty { return "Add at least one To address." }
        if toRecipients.count > 20 || ccRecipients.count > 20 || bccRecipients.count > 20 {
            return "Each recipient field can contain at most 20 addresses."
        }
        let recipients = toRecipients + ccRecipients + bccRecipients
        if recipients.count > 32 { return "A message can have at most 32 recipients." }
        if recipients.contains(where: { !mailAddressIsValid($0) }) {
            return "Check that every recipient is a complete email address."
        }
        if recipients.contains(where: { mailAddressUsesArtekDomain($0) }) {
            return "Artek addresses are outside this personal workspace."
        }
        if Set(recipients.map { $0.lowercased() }).count != recipients.count {
            return "List each recipient only once."
        }
        return nil
    }

    private var subjectError: String? {
        if trimmedSubject.isEmpty { return "Add a subject." }
        if value.subject.contains("\n") || value.subject.contains("\r") {
            return "The subject must stay on one line."
        }
        if subjectLength > 998 { return "Shorten the subject to 998 characters." }
        return nil
    }

    private var bodyError: String? {
        bodyLength > 50_000 ? "Shorten the message to 50,000 characters." : nil
    }

    private var canSend: Bool {
        recipientError == nil && subjectError == nil && bodyError == nil
    }

    private func send() {
        let payload = MailSubmissionPayload(
            to: toRecipients,
            cc: ccRecipients,
            bcc: bccRecipients,
            subject: trimmedSubject,
            body: value.body,
            replyToId: value.replyToId
        )
        let requestId: String
        if let lastSubmission, lastSubmission.payload == payload {
            requestId = lastSubmission.requestId
        } else {
            requestId = UUID().uuidString.lowercased()
            lastSubmission = MailSubmissionAttempt(payload: payload, requestId: requestId)
        }
        let request = GmailSendRequest(
            requestId: requestId,
            to: payload.to,
            cc: payload.cc,
            bcc: payload.bcc,
            subject: payload.subject,
            body: payload.body,
            replyToId: payload.replyToId
        )
        Task {
            if await store.sendGmail(request) { dismiss() }
        }
    }
}

private struct FinanceWorkspaceView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @State private var transactionDraft: FinanceTransaction?

    private var transactions: [FinanceTransaction] {
        store.finance.transactions.sorted {
            if $0.date != $1.date { return $0.date > $1.date }
            return $0.name < $1.name
        }
    }
    private var needsMac: Bool {
        !store.managesAppleHealth && !store.isOnline && !store.loadedAreas.contains(.finance)
    }

    var body: some View {
        List {
            EditorErrorSection(area: .finance)
            if needsMac {
                MacRequiredSection(detail: "Balances and transactions load from Workspace on your Mac and are not saved for offline use on this iPad.")
            } else if store.finance.banks.isEmpty {
                ContentUnavailableView {
                    Label("No finance data", systemImage: "building.columns")
                } description: {
                    Text("Choose which personal accounts belong in Workspace from Settings on your Mac.")
                } actions: {
                    NavigationLink("Open Settings", value: MoreRoute.settings)
                }
            } else {
                ForEach(store.finance.banks) { bank in
                    Section(bank.name) {
                        ForEach(bank.accounts.filter { $0.selected && !$0.blocked }) { account in
                            LabeledContent {
                                Text(account.current.map { moneyLabel($0, currency: account.currency) } ?? "—")
                                    .font(.body.weight(.semibold))
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(account.name)
                                    Text([account.subtype, account.mask.nilIfEmpty.map { "••\($0)" }].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section("Recent transactions") {
                    if transactions.isEmpty {
                        Text("No recent transactions were returned.").foregroundStyle(.secondary)
                    } else {
                        ForEach(transactions) { transaction in
                            Button { transactionDraft = transaction } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(transaction.name).foregroundStyle(.primary)
                                        Text([shortDay(transaction.date), store.finance.annotations[transaction.id]?.category.nilIfEmpty ?? transaction.category.nilIfEmpty, transaction.pending ? "Pending" : nil].compactMap { $0 }.joined(separator: " · "))
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(moneyLabel(transaction.amount, currency: transaction.currency))
                                        .font(.body.monospacedDigit().weight(.medium)).foregroundStyle(.primary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Finances")
        .task { await store.load(.finance) }
        .sheet(item: $transactionDraft) { transaction in
            FinanceAnnotationEditor(transaction: transaction, annotation: store.finance.annotations[transaction.id])
        }
    }
}

private struct FinanceAnnotationEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let transaction: FinanceTransaction
    @State private var category: String
    @State private var note: String
    @State private var excluded: Bool
    @State private var revision: Int

    init(transaction: FinanceTransaction, annotation: TransactionNote?) {
        self.transaction = transaction
        _category = State(initialValue: annotation?.category ?? "")
        _note = State(initialValue: annotation?.note ?? "")
        _excluded = State(initialValue: annotation?.excludeFromSpending ?? false)
        _revision = State(initialValue: annotation?.revision ?? 0)
    }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .finance)
                Section {
                    LabeledContent("Transaction", value: transaction.name)
                    LabeledContent("Amount", value: moneyLabel(transaction.amount, currency: transaction.currency))
                    LabeledContent("Date", value: shortDay(transaction.date))
                }
                Section {
                    TextField("Category", text: $category)
                    TextField("Note", text: $note, axis: .vertical).lineLimit(3...10)
                    Toggle("Exclude from spending", isOn: $excluded)
                } header: {
                    Text("Your context")
                } footer: {
                    Text("Annotations live in your local Workspace. They do not alter the bank transaction.")
                }
            }
            .navigationTitle("Transaction")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() } }
            }
        }
    }

    private func save() {
        let input = FinanceNoteInput(
            transactionId: transaction.id,
            category: category.trimmingCharacters(in: .whitespacesAndNewlines),
            note: note.trimmingCharacters(in: .whitespacesAndNewlines),
            excludeFromSpending: excluded,
            revision: revision
        )
        Task { if await store.annotateFinance(input) { dismiss() } }
    }
}

private struct WritingWorkspaceView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @State private var draft: WritingInput?

    private var needsMac: Bool {
        !store.managesAppleHealth && !store.isOnline && !store.loadedAreas.contains(.writing)
    }

    var body: some View {
        List {
            EditorErrorSection(area: .writing)
            if needsMac {
                MacRequiredSection(detail: "Site entries and Workspace drafts load from your Mac and are not saved for offline use on this iPad.")
            } else {
                if !store.writing.available {
                    ContentUnavailableView {
                        Label("Site entries unavailable", systemImage: "folder.badge.questionmark")
                    } description: {
                        Text("Review the personal site connection from Settings.")
                    } actions: {
                        NavigationLink("Open Settings", value: MoreRoute.settings)
                    }
                }
                Section("Drafts") {
                    if store.writing.drafts.isEmpty {
                        EmptyRow(icon: "square.and.pencil", title: "Something worth writing down", detail: "Start an idea here and continue it from either device.")
                    } else {
                        ForEach(store.writing.drafts.sorted { $0.updatedAt > $1.updatedAt }) { value in
                            Button { draft = value.input } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(value.title.nilIfEmpty ?? "Untitled draft").font(.headline).foregroundStyle(.primary)
                                    Text([enumTitle(value.kind.rawValue), enumTitle(value.primaryThread.rawValue), displayTimestamp(value.updatedAt)].joined(separator: " · "))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Button { draft = .new() } label: { Label("New draft", systemImage: "plus") }
                        .disabled(!store.writing.available)
                }
                if !store.writing.entries.isEmpty {
                    Section {
                        ForEach(store.writing.entries.sorted { $0.order < $1.order }) { entry in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.title).font(.headline)
                                Text(entry.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                                Text(entry.draft ? "Site draft" : "Published in repository").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    } header: {
                        Text("On your site")
                    } footer: {
                        Text("Publishing and site export stay on the Mac so repository changes remain reviewable there.")
                    }
                }
            }
        }
        .navigationTitle("Writing")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !needsMac {
                    Button { draft = .new() } label: { Image(systemName: "square.and.pencil") }
                        .disabled(!store.writing.available)
                        .accessibilityLabel("New writing draft")
                }
            }
        }
        .task { await store.load(.writing) }
        .sheet(item: $draft) { WritingEditor(input: $0) }
    }
}

private struct WritingEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let original: WritingInput
    @State private var value: WritingInput
    @State private var topics: String

    init(input: WritingInput) {
        original = input
        _value = State(initialValue: input)
        _topics = State(initialValue: input.topics.joined(separator: ", "))
    }

    private var dirty: Bool { value != original || topics != original.topics.joined(separator: ", ") }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .writing)
                Section("Draft") {
                    TextField("Title", text: $value.title, axis: .vertical).lineLimit(1...4)
                    TextField("Short summary", text: $value.summary, axis: .vertical).lineLimit(2...6)
                    TextField("Body", text: $value.body, axis: .vertical).lineLimit(10...30)
                }
                Section {
                    TextField("Slug", text: $value.slug)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("Kind", selection: $value.kind) {
                        ForEach(SiteKind.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                    Picker("Primary thread", selection: $value.primaryThread) {
                        ForEach(SiteThread.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                    TextField("Timeframe", text: $value.timeframe)
                    TextField("Format", text: $value.format)
                    TextField("Topics, comma separated", text: $topics)
                } header: {
                    Text("Placement")
                } footer: {
                    Text("Save keeps this as a Workspace draft. Exporting it to your site remains a separate Mac action.")
                }
            }
            .navigationTitle(original.revision == 0 ? "New draft" : "Edit draft")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(value.title.nilIfEmpty == nil) }
            }
            .interactiveDismissDisabled(dirty)
        }
    }

    private func save() {
        value.title = value.title.trimmingCharacters(in: .whitespacesAndNewlines)
        value.summary = value.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        value.slug = slugify(value.slug.nilIfEmpty ?? value.title)
        value.topics = topics.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if !value.threads.contains(value.primaryThread) { value.threads.append(value.primaryThread) }
        let draft = value
        Task { if await store.saveWritingDraft(draft) { dismiss() } }
    }
}

private struct SettingsWorkspaceView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @State private var linkToRemove: IntegrationLink?
    @State private var showingPicker = false
    @State private var showingHealthImport = false
    @State private var confirmUnpair = false
    @State private var weightToReview: WeightCommand?
    @State private var syncResult: String?

    var body: some View {
        Form {
            EditorErrorSection(area: .pairing)
            EditorErrorSection(area: .integrations)
            EditorErrorSection(area: .health)

            Section("Connection") {
                LabeledContent("Status", value: connectionLabel)
                if let credentials = store.credentials {
                    LabeledContent("Mac", value: credentials.url.host ?? credentials.url.absoluteString)
                }
                if let last = store.lastSuccessfulContact {
                    LabeledContent("Last Mac contact", value: last.formatted(date: .abbreviated, time: .shortened))
                }
                if store.pendingCaptureCount > 0 {
                    LabeledContent("Waiting to sync", value: store.pendingCaptureCount.formatted())
                }
                Button { showingPicker = true } label: {
                    Label(store.isPaired ? "Choose a new pairing file" : "Choose pairing file", systemImage: "doc.badge.plus")
                }
                .disabled(store.busy)
                if store.isPaired {
                    Button("Unpair this device", role: .destructive) { confirmUnpair = true }
                        .disabled(store.isLoading(.pairing))
                }
            }

            Section {
                Button {
                    Task {
                        syncResult = nil
                        let workspaceSynced = await store.refreshAll()
                        let synced: Bool
                        if store.managesAppleHealth {
                            let healthSynced = await store.syncHealth()
                            synced = workspaceSynced && healthSynced
                        } else {
                            synced = workspaceSynced
                        }
                        if synced {
                            syncResult = "Synced with your Mac just now."
                        } else if store.connectionNeedsAttention && !store.isOnline {
                            syncResult = "Sync could not complete. Review the connection message above."
                        } else if store.isOnline {
                            syncResult = "The Mac was reached, but part of the sync needs attention. Review the messages above."
                        } else {
                            syncResult = "Your Mac was not available. Saved data remains ready on this device."
                        }
                    }
                } label: {
                    Label(store.busy ? "Syncing…" : "Sync with Mac", systemImage: "arrow.clockwise")
                }
                .disabled(store.busy || !store.isPaired)
                if let syncResult {
                    Text(syncResult)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Sync")
            } footer: {
                Text("Workspace is designed to stay useful between syncs. Open Workspace on your Mac and keep both devices on the same private Wi-Fi when you want to update this device. The USB cable can keep the devices together, but app data currently travels over the local network.")
            }

            if store.managesAppleHealth {
                Section("Apple Health") {
                    Button { Task { await store.authorizeHealth() } } label: {
                        Label("Review Health permissions", systemImage: "lock.shield")
                    }
                    .disabled(store.isLoading(.health))
                    Button { showingHealthImport = true } label: {
                        Label("Import older sleep history", systemImage: "clock.arrow.circlepath")
                    }
                    .disabled(!store.isPaired || store.isLoading(.health) || store.importingHistory)
                    LabeledContent("Recent sleep") {
                        Text(store.sleepStatus).multilineTextAlignment(.trailing).foregroundStyle(.secondary)
                    }
                    if let last = store.healthView?.lastSynced {
                        LabeledContent("Mac snapshot", value: displayTimestamp(last))
                    }
                }
            } else {
                Section {
                    LabeledContent("Apple Health sync", value: "iPhone")
                    if let last = store.healthView?.lastSynced {
                        LabeledContent("Mac snapshot", value: displayTimestamp(last))
                    }
                } header: {
                    Text("Health")
                } footer: {
                    Text("This iPad reads the health summary saved on your Mac. Apple Health permissions, uploads, history imports, and new entries stay on your iPhone.")
                }
            }

            if store.managesAppleHealth && !store.commands.isEmpty {
                Section {
                    ForEach(store.commands) { command in
                        Button { weightToReview = command } label: {
                            HStack {
                                Label(weightLabel(command.kg), systemImage: "scalemass")
                                Spacer()
                                Text(command.measuredAt.formatted(date: .abbreviated, time: .shortened))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Health entries waiting for review")
                } footer: {
                    Text("Workspace never writes a measurement to Apple Health without your confirmation on this iPhone.")
                }
            }

            Section {
                ConnectionProviderRow(name: "Google Calendar", symbol: "calendar", color: .blue, state: store.integrations.google)
                ConnectionProviderRow(name: "Todoist", symbol: "checkmark.circle.fill", color: .red, state: store.integrations.todoist)
            } header: {
                Text("Planning")
            } footer: {
                Text("Authorize providers and choose the Personal calendar and Todoist project from Settings in Workspace on your Mac.")
            }

            if !store.integrations.links.isEmpty {
                Section {
                    ForEach(store.integrations.links) { link in
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(linkTitle(link)).font(.headline)
                                Text("\(enumTitle(link.provider.rawValue)) · \(enumTitle(link.role.rawValue))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(role: .destructive) { linkToRemove = link } label: {
                                Image(systemName: "link.badge.minus")
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Forget link for \(linkTitle(link))")
                        }
                    }
                } header: {
                    Text("Climbing links")
                } footer: {
                    Text("Forgetting a link does not delete the Calendar event or Todoist task.")
                }
            }

            Section {
                Text("Provider credentials remain on your Mac. This device uses the private paired bridge and does not store Google or Todoist credentials.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .task {
            guard store.hasWorkspaceAccess else { return }
            async let integrations = store.load(.integrations)
            async let health = store.load(.health)
            _ = await (integrations, health)
        }
        .sheet(isPresented: $showingHealthImport) { HealthHistoryImportView() }
        .fileImporter(isPresented: $showingPicker, allowedContentTypes: [.json]) { result in
            switch result {
            case .success(let url): Task { await store.pair(url) }
            case .failure(let error): store.report(error, area: .pairing)
            }
        }
        .confirmationDialog("Forget this Workspace link?", isPresented: Binding(get: { linkToRemove != nil }, set: { if !$0 { linkToRemove = nil } }), titleVisibility: .visible) {
            Button("Forget link", role: .destructive) {
                guard let link = linkToRemove else { return }
                linkToRemove = nil
                Task { await store.unlinkIntegration(id: link.id) }
            }
            Button("Keep link", role: .cancel) { linkToRemove = nil }
        } message: { Text("The external item remains unchanged.") }
        .confirmationDialog("Unpair this device?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { Task { await store.unpair() } }
                .disabled(store.isLoading(.pairing))
            Button("Stay paired", role: .cancel) { }
        } message: {
            Text("This immediately removes the token and cached data from this device, then asks your Mac to revoke the pairing. If the Mac cannot confirm, Workspace tells you how to invalidate the token there.")
        }
        .confirmationDialog(
            weightToReview.map { "Save \(weightLabel($0.kg)) to Apple Health?" } ?? "Save this measurement?",
            isPresented: Binding(get: { weightToReview != nil }, set: { if !$0 { weightToReview = nil } }),
            titleVisibility: .visible
        ) {
            Button("Save to Apple Health") {
                guard let command = weightToReview else { return }
                weightToReview = nil
                Task { await store.confirmWeight(command) }
            }
            Button("Not now", role: .cancel) { weightToReview = nil }
        } message: {
            if let command = weightToReview {
                Text("Measured \(command.measuredAt.formatted(date: .abbreviated, time: .shortened)). The app will save this as a user-entered body mass measurement.")
            }
        }
    }

    private func linkTitle(_ link: IntegrationLink) -> String {
        switch link.entityKind {
        case .goal: return store.climbing.goals.first(where: { $0.id == link.entityId })?.title ?? "Climbing goal"
        case .plan: return store.climbing.plans.first(where: { $0.id == link.entityId })?.title ?? "Climbing plan"
        }
    }

    private var connectionLabel: String {
        switch store.connectionState {
        case .unpaired: "Not paired"
        case .connecting: store.hasCachedContent ? "Ready offline" : "Connecting"
        case .online: "Mac available"
        case .offlineWithCache: "Ready offline"
        case .error: "Needs attention"
        }
    }
}

private struct GmailConnectionProviderRow: View {
    let state: GmailState

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "envelope.fill").foregroundStyle(.blue).frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text("Gmail")
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(state.error == nil ? Color.secondary : Color.orange)
            }
            Spacer()
            Image(systemName: state.connected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(state.connected ? Color.green : Color.secondary)
        }
    }

    private var detail: String {
        if let error = state.error?.nilIfEmpty { return error }
        if state.connected { return state.account?.nilIfEmpty ?? "Connected" }
        return state.configured ? "Ready to connect on Mac" : "Set up on Mac"
    }
}

private struct ConnectionProviderRow: View {
    let name: String
    let symbol: String
    let color: Color
    let state: IntegrationProviderState

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).foregroundStyle(color).frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                Text(detail).font(.caption).foregroundStyle(state.error == nil ? Color.secondary : Color.orange)
            }
            Spacer()
            Image(systemName: state.connected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(state.connected ? Color.green : Color.secondary)
        }
    }

    private var detail: String {
        if let error = state.error?.nilIfEmpty { return error }
        if state.connected {
            let selected = state.sources.filter { source in state.selected.contains { $0.id == source.id } }
            let source = selected.isEmpty ? "Connected" : selected.map(\.name).joined(separator: ", ")
            if let last = state.lastSynced { return "\(source) · \(displayTimestamp(last))" }
            return source
        }
        return state.configured ? "Ready to connect on Mac" : "Set up on Mac"
    }
}

private func weightLabel(_ kg: Double) -> String {
    Measurement(value: kg, unit: UnitMass.kilograms)
        .converted(to: Locale.current.measurementSystem == .metric ? .kilograms : .pounds)
        .formatted(.measurement(width: .abbreviated, usage: .asProvided, numberFormatStyle: .number.precision(.fractionLength(1))))
}

private func moneyLabel(_ amount: Double, currency: String?) -> String {
    let code = currency?.nilIfEmpty ?? "USD"
    return amount.formatted(.currency(code: code))
}

private func displayTimestamp(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = formatter.date(from: value)
    if date == nil {
        formatter.formatOptions = [.withInternetDateTime]
        date = formatter.date(from: value)
    }
    return date?.formatted(date: .abbreviated, time: .shortened) ?? value
}

private func safeGmailURL(_ value: String) -> URL? {
    guard let url = URL(string: value),
          url.scheme?.lowercased() == "https",
          url.host?.lowercased() == "mail.google.com" else { return nil }
    return url
}

private func parseMailRecipients(_ value: String) -> [String] {
    value.components(separatedBy: CharacterSet(charactersIn: ",;\n"))
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
}

private func mailAddressIsValid(_ value: String) -> Bool {
    guard (3...320).contains(value.utf16.count),
          !value.contains("\r"),
          !value.contains("\n") else { return false }
    let pattern = #"^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$"#
    return value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
}

private func mailAddressUsesArtekDomain(_ value: String) -> Bool {
    guard let at = value.lastIndex(of: "@") else { return false }
    let domain = value[value.index(after: at)...].lowercased()
    return domain == "artek.energy" || domain.hasSuffix(".artek.energy")
}

private func slugify(_ value: String) -> String {
    value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        .lowercased()
        .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
}
