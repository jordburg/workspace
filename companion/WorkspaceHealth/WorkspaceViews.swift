import SwiftUI
import UniformTypeIdentifiers

// MARK: - App shell

enum WorkspaceTab: Hashable {
    case today
    case inbox
    case climbing
    case health
    case more
}

private enum MoreRoute: Hashable {
    case mail
    case pairing
}

struct WorkspaceRootView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: WorkspaceTab = .today
    @State private var selectedDay = Date()
    @State private var morePath: [MoreRoute] = []

    var body: some View {
        ZStack {
            TabView(selection: $tab) {
                NavigationStack {
                    TodayView(
                        selectedDay: $selectedDay,
                        openClimbing: { tab = .climbing },
                        openHealth: { tab = .health },
                        openMail: openMail,
                        openPairing: openPairing
                    )
                }
                .tabItem { Label("Today", systemImage: "sun.max") }
                .tag(WorkspaceTab.today)

                NavigationStack {
                    InboxView(selectedDay: $selectedDay, openPairing: openPairing)
                }
                .tabItem { Label("Inbox", systemImage: "tray") }
                .tag(WorkspaceTab.inbox)

                NavigationStack {
                    ClimbingView(selectedDay: $selectedDay, openPairing: openPairing)
                }
                .tabItem { Label("Climbing", systemImage: "mountain.2") }
                .tag(WorkspaceTab.climbing)

                NavigationStack {
                    HealthWorkspaceView(selectedDay: $selectedDay, openPairing: openPairing)
                }
                .tabItem { Label("Health", systemImage: "heart") }
                .tag(WorkspaceTab.health)

                NavigationStack(path: $morePath) {
                    MoreView()
                        .navigationDestination(for: MoreRoute.self) { route in
                            switch route {
                            case .mail: MailWorkspaceView()
                            case .pairing: PairingSyncView()
                            }
                        }
                }
                .tabItem { Label("More", systemImage: "ellipsis") }
                .tag(WorkspaceTab.more)
            }
            if scenePhase != .active {
                WorkspacePrivacyCover()
                    .transition(.opacity)
                    .zIndex(10)
            }
        }
        .tint(.teal)
        .task {
            await store.loadInitial()
            if UserDefaults.standard.bool(forKey: "healthPermissionsRequested") {
                await store.syncHealth()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                await store.refreshAll()
                if UserDefaults.standard.bool(forKey: "healthPermissionsRequested") {
                    await store.syncHealth()
                }
            }
        }
    }

    private func openPairing() {
        morePath = [.pairing]
        tab = .more
    }

    private func openMail() {
        morePath = [.mail]
        tab = .more
    }
}

private struct WorkspacePrivacyCover: View {
    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            VStack(spacing: 12) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(.teal)
                Text("Workspace")
                    .font(.title2.weight(.semibold))
                Text("Return to the app to view your private workspace.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.center)
            .padding()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Workspace content hidden")
    }
}

private enum MobileAreaFilter: String, CaseIterable, Identifiable {
    case all
    case personal
    case independent

    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "All areas"
        case .personal: "Personal"
        case .independent: "Independent work"
        }
    }

    func includes(_ area: LifeArea) -> Bool {
        self == .all || rawValue == area.rawValue
    }
}

private struct WorkspaceStatusBanner: View {
    @EnvironmentObject private var store: WorkspaceStore
    let openPairing: (() -> Void)?

    var body: some View {
        if !store.isPaired {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Pair with your Mac", systemImage: "iphone.and.arrow.forward")
                        .font(.headline)
                    Text("Your Workspace stays on your Mac. Pair this iPhone on the same private Wi-Fi to bring it here.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let openPairing {
                        Button("Open pairing") { openPairing() }
                    }
                }
            }
        } else if !store.hasWorkspaceAccess {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Pair again for the full Workspace", systemImage: "lock.trianglebadge.exclamationmark")
                        .font(.headline)
                    Text("This saved pairing can sync Health only. Create a new Workspace pairing file on your Mac.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let openPairing {
                        Button("Open pairing") { openPairing() }
                    }
                }
            }
        } else if let error = store.error {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Workspace needs attention", systemImage: "exclamationmark.triangle.fill")
                        .font(.headline)
                        .foregroundStyle(.orange)
                    Text(error).font(.subheadline)
                    Button("Dismiss") { store.clearError() }
                        .font(.subheadline.weight(.semibold))
                }
            }
        }
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
    let openClimbing: () -> Void
    let openHealth: () -> Void
    let openMail: () -> Void
    let openPairing: () -> Void

    @State private var area: MobileAreaFilter = .all
    @State private var itemDraft: WorkspaceItemDraft?
    @State private var taskDraft: RemoteTaskDraft?
    @State private var eventDraft: RemoteEventDraft?
    @State private var taskToComplete: RemoteTask?

    private var day: String { WorkspaceFormat.dayKey(selectedDay) }
    private var today: String { WorkspaceFormat.dayKey() }
    private var priorities: [WorkspaceItem] {
        store.workspace.items.filter { $0.kind == .priority && $0.date == day && area.includes($0.area) }
    }
    private var tasks: [RemoteTask] {
        guard area != .independent else { return [] }
        return store.integrations.tasks
            .filter { task in
                task.area == .personal && (task.dueDate == day || (day == today && task.dueDate.map { $0 < day } == true))
            }
            .sorted {
                let leftTime = $0.dueTime ?? "99:99"
                let rightTime = $1.dueTime ?? "99:99"
                if leftTime != rightTime { return leftTime < rightTime }
                return $0.priority > $1.priority
            }
    }
    private var agenda: [MobileAgendaEntry] {
        let local = store.workspace.items.compactMap { item -> MobileAgendaEntry? in
            guard item.kind == .plan, item.date == day, area.includes(item.area) else { return nil }
            return MobileAgendaEntry(
                id: "local:\(item.id)", title: item.title, time: item.time, endTime: item.endTime,
                allDay: false, subtitle: item.area == .personal ? "Personal · Local plan" : "Independent work · Local plan",
                source: .local(item)
            )
        }
        let remote: [MobileAgendaEntry] = area == .independent ? [] : store.integrations.events.compactMap { event in
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

    var body: some View {
        List {
            WorkspaceStatusBanner(openPairing: openPairing)
            WorkspaceConflictBanner()
            Section {
                WeekDayPicker(selection: $selectedDay)
            }

            Section("Priorities") {
                if priorities.isEmpty {
                    EmptyRow(icon: "sparkles", title: "What would make this a good day?", detail: "Choose one important thing to move forward.")
                } else {
                    ForEach(priorities) { item in
                        HStack(spacing: 12) {
                            Button {
                                let openingState = store.workspace
                                guard var changed = openingState.items.first(where: {
                                    $0.id == item.id && $0.kind == .priority && $0.date == day
                                }) else {
                                    store.reportStaleRow("Workspace item", area: .workspace)
                                    return
                                }
                                changed.done.toggle()
                                Task { await store.upsertWorkspaceItem(changed, openingState: openingState) }
                            } label: {
                                Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(item.done ? Color.teal : Color.secondary)
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
                Button { presentNewItem(.new(kind: .priority, area: defaultArea, date: day)) } label: {
                    Label("Add a priority", systemImage: "plus")
                }
            }

            if store.integrations.todoist.connected && area != .independent {
                Section {
                    if tasks.isEmpty {
                        Text("No Todoist tasks due on this day.").foregroundStyle(.secondary)
                    } else {
                        ForEach(tasks) { task in
                            Button { taskDraft = RemoteTaskDraft(task: task, day: day, link: nil) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "circle")
                                        .foregroundStyle(.red)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(task.title).foregroundStyle(.primary)
                                        Text(taskMetadata(task, relativeTo: day))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                Button { taskToComplete = task } label: { Label("Complete", systemImage: "checkmark") }
                                    .tint(.green)
                            }
                        }
                    }
                    Button { taskDraft = RemoteTaskDraft(task: nil, day: day, link: nil) } label: {
                        Label("Add Todoist task", systemImage: "plus")
                    }
                } header: {
                    Label("Todoist · Personal", systemImage: "checkmark.circle")
                }
            }

            Section("Your day") {
                if agenda.isEmpty {
                    EmptyRow(icon: "calendar", title: "A little breathing room", detail: "Add an appointment, a focus block, or something you are looking forward to.")
                } else {
                    ForEach(agenda) { entry in
                        Button { openAgenda(entry) } label: {
                            AgendaRow(entry: entry)
                        }
                        .buttonStyle(.plain)
                    }
                }
                Menu {
                    Button("Local plan", systemImage: "calendar.badge.plus") {
                        var plan = WorkspaceItem.new(kind: .plan, area: defaultArea, date: day)
                        plan.time = "09:00"
                        presentNewItem(plan)
                    }
                    if store.integrations.google.connected && area != .independent {
                        Button("Google Calendar event", systemImage: "calendar") {
                            eventDraft = RemoteEventDraft(event: nil, day: day, presetTitle: nil, presetLocation: nil, link: nil)
                        }
                    }
                } label: {
                    Label("Add to your day", systemImage: "plus")
                }
            }

            Section("A wider view") {
                Button(action: openMail) {
                    SummaryRow(icon: "envelope.fill", color: .blue, title: "Mail", detail: mailSummary)
                }
                Button(action: openHealth) {
                    SummaryRow(icon: "heart.fill", color: .pink, title: "Apple Health", detail: healthSummary)
                }
                Button(action: openClimbing) {
                    SummaryRow(icon: "mountain.2.fill", color: .orange, title: "Climbing", detail: climbingSummary)
                }
            }
        }
        .navigationTitle(day == today ? "Today" : shortDay(day))
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Picker("Life area", selection: $area) {
                        ForEach(MobileAreaFilter.allCases) { value in Text(value.title).tag(value) }
                    }
                } label: {
                    Label(area.title, systemImage: "line.3.horizontal.decrease.circle")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Priority", systemImage: "sparkles") { presentNewItem(.new(kind: .priority, area: defaultArea, date: day)) }
                    Button("Plan", systemImage: "calendar.badge.plus") {
                        var plan = WorkspaceItem.new(kind: .plan, area: defaultArea, date: day)
                        plan.time = "09:00"
                        presentNewItem(plan)
                    }
                    Button("Thought", systemImage: "tray.and.arrow.down") { presentNewItem(.new(kind: .note, area: defaultArea)) }
                    if store.integrations.todoist.connected && area != .independent {
                        Button("Todoist task", systemImage: "checkmark.circle") { taskDraft = RemoteTaskDraft(task: nil, day: day, link: nil) }
                    }
                    if store.integrations.google.connected && area != .independent {
                        Button("Calendar event", systemImage: "calendar") { eventDraft = RemoteEventDraft(event: nil, day: day, presetTitle: nil, presetLocation: nil, link: nil) }
                    }
                } label: { Image(systemName: "plus") }
                .disabled(!store.hasWorkspaceAccess)
            }
        }
        .refreshable {
            await store.refreshAll()
            await store.refreshIntegrations(on: day)
        }
        .task(id: day) {
            guard store.hasWorkspaceAccess else { return }
            await store.refreshIntegrations(on: day)
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

    private var defaultArea: LifeArea { area == .independent ? .independent : .personal }

    private var mailSummary: String {
        let gmail = store.integrations.gmail
        guard gmail.connected else {
            return gmail.configured ? "Connect Gmail on your Mac" : "Set up Gmail on your Mac"
        }
        if gmail.unreadCount == 0 { return "Recent inbox clear" }
        let label = gmail.unreadCount == 1 ? "1 unread in recent inbox" : "\(gmail.unreadCount) unread in recent inbox"
        let first = store.integrations.messages.first(where: \.unread)?.subject.nilIfEmpty
        return [label, first].compactMap { $0 }.joined(separator: " · ")
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

    private var healthSummary: String {
        guard let value = store.healthSnapshot?.days.first(where: { $0.date == day }) else {
            return store.isPaired ? "No synced reading for this day" : "Pair your iPhone and Mac"
        }
        let steps = value.steps.map { "\(Int($0).formatted()) steps" }
        let sleep = value.sleepMinutes.map { minutesLabel(Int($0.rounded())) }
        return [steps, sleep].compactMap { $0 }.joined(separator: " · ").nilIfEmpty ?? "No accessible data"
    }

    private var climbingSummary: String {
        let sessions = store.climbing.sessions.filter { $0.deletedAt == nil && $0.date == day }
        if let session = sessions.sorted(by: { $0.updatedAt > $1.updatedAt }).first {
            return ["Session logged", session.venue, session.durationMinutes.map(minutesLabel), session.healthWorkoutId == nil ? nil : "Health linked"]
                .compactMap { $0?.nilIfEmpty }.joined(separator: " · ")
        }
        let planned = store.climbing.plans.filter { $0.status == .planned && effectivePlanDay($0) == day }
        if let plan = planned.sorted(by: { ($0.startTime ?? "99:99") < ($1.startTime ?? "99:99") }).first {
            return [effectivePlanTime(plan), plan.title, effectivePlanVenue(plan)].compactMap { $0?.nilIfEmpty }.joined(separator: " · ")
        }
        if let goal = store.climbing.goals.first(where: { $0.archivedAt == nil && $0.status == .active }) {
            return goal.nextStep.isEmpty ? "Active goal · \(goal.title)" : "Next · \(goal.nextStep)"
        }
        return "Log or plan a climbing session"
    }

    private func effectivePlanEvent(_ plan: ClimbingPlan) -> RemoteEvent? {
        guard let link = store.integrations.links.first(where: { $0.entityKind == .plan && $0.entityId == plan.id && $0.role == .scheduledSession }) else { return nil }
        return store.integrations.events.first { $0.id == link.remoteId }
    }
    private func effectivePlanDay(_ plan: ClimbingPlan) -> String { effectivePlanEvent(plan)?.startDate ?? plan.date }
    private func effectivePlanVenue(_ plan: ClimbingPlan) -> String? { effectivePlanEvent(plan)?.location.nilIfEmpty ?? plan.venue.nilIfEmpty }
    private func effectivePlanTime(_ plan: ClimbingPlan) -> String? {
        guard let value = effectivePlanEvent(plan)?.startTime ?? plan.startTime else { return "Planned" }
        return clockLabel(value)
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
            case .local: Image(systemName: "iphone").foregroundStyle(.secondary)
            case .google: Image(systemName: "calendar").foregroundStyle(.blue)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct SummaryRow: View {
    let icon: String
    let color: Color
    let title: String
    let detail: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(color).frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline).foregroundStyle(.secondary)
                Text(detail).font(.body.weight(.medium)).foregroundStyle(.primary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
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
            Image(systemName: icon).foregroundStyle(.teal).frame(width: 24)
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
                Spacer()
                Text(selection.formatted(.dateTime.month(.wide).year()))
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button { shift(7) } label: { Image(systemName: "chevron.right") }
            }
            HStack(spacing: 4) {
                ForEach(days, id: \.self) { date in
                    Button { selection = date } label: {
                        VStack(spacing: 5) {
                            Text(date.formatted(.dateTime.weekday(.narrow))).font(.caption2)
                            Text(date.formatted(.dateTime.day())).font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(Calendar.current.isDate(date, inSameDayAs: selection) ? Color.teal : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                        .foregroundStyle(Calendar.current.isDate(date, inSameDayAs: selection) ? Color.white : Color.primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(date.formatted(date: .complete, time: .omitted))
                }
            }
            if !Calendar.current.isDateInToday(selection) {
                Button("Return to today") { selection = Date() }.font(.caption)
            }
        }
    }

    private func shift(_ days: Int) {
        selection = Calendar.current.date(byAdding: .day, value: days, to: selection) ?? selection
    }
}

// MARK: - Inbox

struct InboxView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Binding var selectedDay: Date
    let openPairing: () -> Void
    @State private var capture = ""
    @State private var itemDraft: WorkspaceItemDraft?
    @State private var taskDraft: RemoteTaskDraft?
    @State private var noteToDelete: WorkspaceItemDraft?
    @State private var search = ""

    private var notes: [WorkspaceItem] {
        store.workspace.items.filter {
            $0.kind == .note && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search))
        }.reversed()
    }
    private var unscheduledTasks: [RemoteTask] {
        store.integrations.tasks.filter {
            $0.dueDate == nil && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search))
        }
    }

    var body: some View {
        List {
            WorkspaceStatusBanner(openPairing: openPairing)
            WorkspaceConflictBanner()
            Section {
                TextField("What is on your mind?", text: $capture, axis: .vertical)
                    .lineLimit(2...6)
                Button {
                    saveCapture()
                } label: {
                    Label("Save to Inbox", systemImage: "arrow.down.to.line")
                }
                .disabled(capture.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.hasWorkspaceAccess)
            } header: { Text("A place to put it") }
              footer: { Text("The text stays here until the Mac confirms it was saved.") }

            Section("Captured thoughts") {
                if notes.isEmpty {
                    Text(search.isEmpty ? "Nothing on the back burner." : "No matching thoughts.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(notes) { note in
                        Button { presentExistingItem(id: note.id) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(note.title).foregroundStyle(.primary)
                                Text(note.area == .personal ? "Personal" : "Independent work")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            Button { makePriority(id: note.id) } label: { Label("Prioritize", systemImage: "sparkles") }
                                .tint(.teal)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) { noteToDelete = existingDraft(id: note.id) } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
                }
            }

            if store.integrations.todoist.connected {
                Section("Unscheduled in Todoist") {
                    if unscheduledTasks.isEmpty {
                        Text(search.isEmpty ? "No unscheduled Personal tasks." : "No matching Todoist tasks.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(unscheduledTasks) { task in
                            Button { taskDraft = RemoteTaskDraft(task: task, day: WorkspaceFormat.dayKey(selectedDay), link: nil) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(task.title).foregroundStyle(.primary)
                                    Text(task.sourceName).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Button { taskDraft = RemoteTaskDraft(task: nil, day: WorkspaceFormat.dayKey(selectedDay), link: nil) } label: {
                        Label("Add Todoist task", systemImage: "plus")
                    }
                }
            }
        }
        .navigationTitle("Inbox")
        .searchable(text: $search, prompt: "Search thoughts and tasks")
        .refreshable {
            await store.refreshAll()
            await store.refreshIntegrations(on: WorkspaceFormat.dayKey(selectedDay))
        }
        .sheet(item: $itemDraft) { WorkspaceItemEditor(draft: $0) }
        .sheet(item: $taskDraft) { TodoistTaskEditor(draft: $0) }
        .confirmationDialog(
            noteToDelete.map { "Delete “\($0.item.title)”?" } ?? "Delete this thought?",
            isPresented: Binding(get: { noteToDelete != nil }, set: { if !$0 { noteToDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete from Workspace", role: .destructive) {
                guard let draft = noteToDelete else { return }
                noteToDelete = nil
                Task { await store.removeWorkspaceItem(id: draft.item.id, openingState: draft.openingState) }
            }
            Button("Cancel", role: .cancel) { noteToDelete = nil }
        } message: { Text("This removes the saved thought from your Mac.") }
    }

    private func saveCapture() {
        let text = capture.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        var note = WorkspaceItem.new(kind: .note)
        note.title = text
        let openingState = store.workspace
        Task {
            await store.upsertWorkspaceItem(note, openingState: openingState)
            if store.workspace.items.contains(where: { $0.id == note.id }) { capture = "" }
        }
    }

    private func makePriority(id: String) {
        let openingState = store.workspace
        guard var priority = openingState.items.first(where: { $0.id == id }) else {
            store.reportStaleRow("Workspace item", area: .workspace)
            return
        }
        priority.kind = .priority
        priority.date = WorkspaceFormat.dayKey(selectedDay)
        priority.time = nil
        priority.endTime = nil
        priority.done = false
        Task { await store.upsertWorkspaceItem(priority, openingState: openingState) }
    }

    private func existingDraft(id: String) -> WorkspaceItemDraft? {
        let openingState = store.workspace
        guard let item = openingState.items.first(where: { $0.id == id }) else {
            store.reportStaleRow("Workspace item", area: .workspace)
            return nil
        }
        return WorkspaceItemDraft(
            item: item,
            openingState: openingState,
            isNew: false
        )
    }

    private func presentExistingItem(id: String) {
        itemDraft = existingDraft(id: id)
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
                        Text("Thought").tag(WorkspaceItemKind.note)
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
    let openPairing: () -> Void

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
            WorkspaceStatusBanner(openPairing: openPairing)
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
        .navigationTitle("Climbing")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { createForSection() } label: { Image(systemName: "plus") }
                    .disabled(!store.hasWorkspaceAccess)
            }
        }
        .refreshable {
            await store.load(.climbing, force: true)
            await store.refreshIntegrations(on: day)
            await store.load(.health, force: true)
        }
        .task {
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
                                Label("Calendar link unavailable. Refresh, or forget the old link in Connections.", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
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
                    VStack(alignment: .leading, spacing: 8) {
                        Button { presentExistingGoal(id: goal.id) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Text(goal.title).font(.headline).foregroundStyle(.primary)
                                    Spacer()
                                    Text(goalProgress(goal).label).font(.caption.weight(.semibold)).foregroundStyle(.teal)
                                }
                                ProgressView(value: goalProgress(goal).percent, total: 100).tint(.teal)
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
                                Label("Todoist link unavailable. Refresh, or forget the old link in Connections.", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
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
                        Text("Sync Apple Health to find workouts on this date.").font(.caption).foregroundStyle(.secondary)
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
                Section("Connections") {
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
    let original: ClimbingGoal
    @State private var value: ClimbingGoal
    @State private var openingState: ClimbingState
    @State private var wasNew: Bool
    @State private var hasStartDate: Bool
    @State private var hasTargetDate: Bool
    @State private var hasSessionTarget: Bool
    @State private var confirmArchive = false

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
    private var dirty: Bool { value != original }

    var body: some View {
        NavigationStack {
            Form {
                EditorErrorSection(area: .climbing)
                ClimbingEditorConflictSection()
                Section("Goal") {
                    TextField("What are you working toward?", text: $value.title, axis: .vertical).lineLimit(2...5)
                    Picker("Kind", selection: $value.kind) {
                        ForEach(ClimbingGoalKind.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                    .onChange(of: value.kind) { _, kind in
                        guard kind == .consistency else { return }
                        hasStartDate = true
                        hasTargetDate = true
                        hasSessionTarget = true
                        value.startDate = value.startDate ?? WorkspaceFormat.dayKey()
                        value.targetDate = value.targetDate ?? shiftDay(WorkspaceFormat.dayKey(), by: 28)
                        value.sessionTarget = value.sessionTarget ?? 8
                    }
                    TextField("Why it matters or what success looks like", text: $value.description, axis: .vertical).lineLimit(3...8)
                    Picker("Status", selection: $value.status) {
                        ForEach(ClimbingGoalStatus.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0) }
                    }
                    if value.kind != .consistency {
                        Stepper("Progress · \(value.progress)%", value: $value.progress, in: 0...100, step: 5)
                    }
                    TextField("Next step", text: $value.nextStep, axis: .vertical).lineLimit(2...5)
                }
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
                    TextField("Venue (optional)", text: Binding(get: { value.venue ?? "" }, set: { value.venue = $0.nilIfEmpty }))
                    Picker("Grade system", selection: Binding(
                        get: { value.gradeSystem?.rawValue ?? "none" },
                        set: { value.gradeSystem = $0 == "none" ? nil : GradeSystem(rawValue: $0) }
                    )) {
                        Text("Not specified").tag("none")
                        ForEach(GradeSystem.allCases, id: \.self) { Text(enumTitle($0.rawValue)).tag($0.rawValue) }
                    }
                    TextField("Grade (optional)", text: Binding(get: { value.grade ?? "" }, set: { value.grade = $0.nilIfEmpty }))
                    Picker("Routine", selection: Binding(get: { value.routineId ?? "none" }, set: { value.routineId = $0 == "none" ? nil : $0 })) {
                        Text("No routine").tag("none")
                        ForEach(openingState.routines.filter { !$0.archived }) { Text($0.title).tag($0.id) }
                    }
                }
                if !isNew {
                    Section {
                        Button("Archive goal", role: .destructive) { confirmArchive = true }
                            .disabled(store.climbingConflict != nil)
                    }
                }
            }
            .navigationTitle(isNew ? "New goal" : "Edit goal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(!goalIsValid || store.climbingConflict != nil)
                }
            }
            .interactiveDismissDisabled(dirty)
            .confirmationDialog("Archive this goal?", isPresented: $confirmArchive, titleVisibility: .visible) {
                Button("Archive goal", role: .destructive) { archive() }
                    .disabled(store.climbingConflict != nil)
                Button("Keep active", role: .cancel) { }
            } message: { Text("Its history stays in the Workspace. Any linked Todoist task remains in Todoist.") }
        }
    }

    private func normalized() -> ClimbingGoal {
        var result = value
        result.title = result.title.trimmingCharacters(in: .whitespacesAndNewlines)
        result.description = result.description.trimmingCharacters(in: .whitespacesAndNewlines)
        result.nextStep = result.nextStep.trimmingCharacters(in: .whitespacesAndNewlines)
        if !hasStartDate { result.startDate = nil }
        if !hasTargetDate { result.targetDate = nil }
        if result.kind != .consistency || !hasSessionTarget { result.sessionTarget = nil }
        result.updatedAt = WorkspaceFormat.timestamp()
        return result
    }

    private var goalIsValid: Bool {
        guard value.title.nilIfEmpty != nil else { return false }
        guard (value.gradeSystem == nil) == (value.grade?.nilIfEmpty == nil) else { return false }
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
    let date: String
    let steps: Double?
    let sleepMinutes: Double?
    let restingHeartRate: Double?
    let weightKg: Double?
}

struct HealthWorkspaceView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Binding var selectedDay: Date
    let openPairing: () -> Void

    @State private var showingImport = false
    @State private var weightToReview: WeightCommand?

    private var day: String { WorkspaceFormat.dayKey(selectedDay) }
    private var healthDay: MobileHealthDay? {
        if let local = store.healthSnapshot?.days.first(where: { $0.date == day }) {
            return MobileHealthDay(date: local.date, steps: local.steps, sleepMinutes: local.sleepMinutes, restingHeartRate: local.restingHeartRate, weightKg: local.weightKg)
        }
        if let remote = store.healthView?.snapshot?.days.first(where: { $0.date == day }) {
            return MobileHealthDay(date: remote.date, steps: remote.steps, sleepMinutes: remote.sleepMinutes, restingHeartRate: remote.restingHeartRate, weightKg: remote.weightKg)
        }
        return nil
    }
    private var workouts: [UnifiedHealthWorkout] {
        preferredHealthWorkouts(
            on: day,
            localSnapshot: store.healthSnapshot,
            remoteSnapshot: store.healthView?.snapshot
        ).sorted { $0.start < $1.start }
    }

    var body: some View {
        List {
            WorkspaceStatusBanner(openPairing: openPairing)
            Section { WeekDayPicker(selection: $selectedDay) }

            Section("Daily snapshot") {
                if let healthDay {
                    HealthMetricRow(icon: "figure.walk", color: .green, title: "Steps", value: healthDay.steps.map { Int($0).formatted() } ?? "—")
                    HealthMetricRow(icon: "bed.double.fill", color: .indigo, title: "Sleep", value: healthDay.sleepMinutes.map { minutesLabel(Int($0.rounded())) } ?? "—")
                    HealthMetricRow(icon: "heart.fill", color: .pink, title: "Resting heart rate", value: healthDay.restingHeartRate.map { "\(Int($0.rounded())) bpm" } ?? "—")
                    HealthMetricRow(icon: "scalemass.fill", color: .blue, title: "Weight", value: healthDay.weightKg.map(weightLabel) ?? "—")
                } else {
                    EmptyRow(icon: "heart.text.square", title: "No accessible readings", detail: "Sync Apple Health, or choose another day. Apple only returns categories you allowed.")
                }
            }

            Section("Workouts") {
                if workouts.isEmpty {
                    Text("No accessible workouts on this day.").foregroundStyle(.secondary)
                } else {
                    ForEach(workouts) { workout in
                        HStack(spacing: 12) {
                            Image(systemName: workout.activity == "climbing" ? "mountain.2.fill" : "figure.run")
                                .foregroundStyle(workout.activity == "climbing" ? Color.orange : Color.teal)
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

            if !store.commands.isEmpty {
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

            Section("Apple Health sync") {
                Button { Task { await store.authorizeHealth() } } label: {
                    Label("Review Health permissions", systemImage: "lock.shield")
                }
                Button { Task { await store.syncHealth() } } label: {
                    Label(store.isLoading(.health) ? "Syncing…" : "Sync now", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(!store.isPaired || store.isLoading(.health))
                Button { showingImport = true } label: {
                    Label("Import older sleep history", systemImage: "clock.arrow.circlepath")
                }
                .disabled(!store.isPaired || store.importingHistory)
                LabeledContent("Recent sleep") { Text(store.sleepStatus).multilineTextAlignment(.trailing).foregroundStyle(.secondary) }
                if let last = store.healthView?.lastSynced {
                    LabeledContent("Mac snapshot", value: displayTimestamp(last))
                }
            }
        }
        .navigationTitle("Health")
        .refreshable {
            await store.syncHealth()
            await store.load(.health, force: true)
        }
        .task {
            await store.load(.health)
            if weightToReview == nil { weightToReview = store.commands.first }
        }
        .onChange(of: store.commands) { _, commands in
            if weightToReview == nil { weightToReview = commands.first }
        }
        .sheet(isPresented: $showingImport) { HealthHistoryImportView() }
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
            WorkspaceStatusBanner(openPairing: nil)
            Section("Workspace") {
                NavigationLink { MailWorkspaceView() } label: {
                    MoreDestinationRow(icon: "envelope.fill", color: .blue, title: "Email", detail: mailDetail)
                }
                NavigationLink { FinanceWorkspaceView() } label: {
                    MoreDestinationRow(icon: "wallet.bifold.fill", color: .green, title: "Finances", detail: financeDetail)
                }
                NavigationLink { WritingWorkspaceView() } label: {
                    MoreDestinationRow(icon: "square.and.pencil", color: .purple, title: "Writing", detail: writingDetail)
                }
            }
            Section("Connected services") {
                NavigationLink { ConnectionsView() } label: {
                    MoreDestinationRow(icon: "link", color: .blue, title: "Connections", detail: connectionsDetail)
                }
                NavigationLink { PairingSyncView() } label: {
                    MoreDestinationRow(icon: "iphone.and.arrow.forward", color: .teal, title: "Pairing & Sync", detail: store.isPaired ? store.status : "Pair with your Mac")
                }
            }
            Section {
                Text("Provider credentials and account selection are managed in Workspace on your Mac. This iPhone uses the private paired bridge and never stores your Google, Todoist, or Plaid credentials.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("More")
        .refreshable { await store.refreshAll() }
    }

    private var financeDetail: String {
        guard store.finance.configured else { return "Set up Plaid on your Mac" }
        return "\(store.finance.banks.count) institutions · \(store.finance.transactions.count) recent transactions"
    }
    private var mailDetail: String {
        let gmail = store.integrations.gmail
        guard gmail.connected else { return gmail.configured ? "Connect Gmail on your Mac" : "Set up Gmail on your Mac" }
        let unread = gmail.unreadCount == 1 ? "1 unread recently" : "\(gmail.unreadCount) unread recently"
        return [gmail.account?.nilIfEmpty, unread].compactMap { $0 }.joined(separator: " · ")
    }
    private var writingDetail: String {
        guard store.writing.available else { return "Connect the site repository on your Mac" }
        return "\(store.writing.drafts.count) drafts · \(store.writing.entries.count) site entries"
    }
    private var connectionsDetail: String {
        let count = [store.integrations.google.connected, store.integrations.gmail.connected, store.integrations.todoist.connected].filter { $0 }.count
        return count == 0 ? "Google Calendar, Gmail, and Todoist" : "\(count) of 3 connected"
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

    var body: some View {
        List {
            WorkspaceStatusBanner(openPairing: nil)
            EditorErrorSection(area: .integrations)

            if !store.integrations.gmail.connected {
                Section {
                    Label(
                        store.integrations.gmail.configured ? "Connect Gmail in Workspace on your Mac" : "Set up Gmail in Workspace on your Mac",
                        systemImage: "desktopcomputer"
                    )
                    .font(.headline)
                    Text("Google authorization stays on your Mac. Once connected, this iPhone receives only the mail view and actions through the private paired bridge.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Personal Gmail")
                }
            } else {
                Section {
                    if messages.isEmpty {
                        EmptyRow(
                            icon: "envelope.open",
                            title: search.isEmpty ? "No messages in this view" : "No matching messages",
                            detail: search.isEmpty ? "Pull to refresh when you want to check again." : "Try a sender, subject, or different phrase."
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
                } footer: {
                    if let account = store.integrations.gmail.account?.nilIfEmpty {
                        Text(account)
                    }
                }
            }
        }
        .navigationTitle("Mail")
        .searchable(text: $search, prompt: "Search loaded mail")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    composeDraft = MailComposeDraft()
                } label: {
                    Label("Compose", systemImage: "square.and.pencil")
                }
                .disabled(!store.integrations.gmail.connected || store.isLoading(.integrations))

                Button {
                    Task { await store.refreshIntegrations() }
                } label: {
                    if store.isLoading(.integrations) { ProgressView() }
                    else { Image(systemName: "arrow.clockwise") }
                }
                .disabled(!store.hasWorkspaceAccess || store.isLoading(.integrations))
            }
        }
        .refreshable { await store.refreshIntegrations() }
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
                        .disabled(store.isLoading(.integrations))
                    }
                }
            } else {
                ContentUnavailableView(
                    "Message no longer in Inbox",
                    systemImage: "tray",
                    description: Text("It may have been archived or moved to Trash. Refresh Mail to load the current Inbox.")
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

    var body: some View {
        List {
            if !store.finance.configured {
                ContentUnavailableView {
                    Label("Set up Plaid on your Mac", systemImage: "building.columns")
                } description: {
                    Text("Bank credentials and institution changes stay in the desktop Workspace. They are not entered or stored on this iPhone.")
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
                        if let error = bank.error?.nilIfEmpty {
                            Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
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
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await store.syncFinance() } } label: {
                    if store.isLoading(.finance) { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                }
                .disabled(!store.finance.configured || store.isLoading(.finance))
                .accessibilityLabel("Refresh finances")
            }
        }
        .refreshable {
            if store.finance.configured { await store.syncFinance() }
            else { await store.load(.finance, force: true) }
        }
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

    var body: some View {
        List {
            if !store.writing.available {
                ContentUnavailableView {
                    Label("Connect your site on the Mac", systemImage: "folder.badge.questionmark")
                } description: {
                    Text(store.writing.error ?? "Choose the personal site repository in the desktop Workspace before writing here.")
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
        .navigationTitle("Writing")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { draft = .new() } label: { Image(systemName: "square.and.pencil") }
                    .disabled(!store.writing.available)
            }
        }
        .refreshable { await store.load(.writing, force: true) }
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

private struct ConnectionsView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @State private var linkToRemove: IntegrationLink?

    var body: some View {
        List {
            Section("Providers") {
                ConnectionProviderRow(name: "Google Calendar", symbol: "calendar", color: .blue, state: store.integrations.google)
                GmailConnectionProviderRow(state: store.integrations.gmail)
                ConnectionProviderRow(name: "Todoist", symbol: "checkmark.circle.fill", color: .red, state: store.integrations.todoist)
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
                            Button(role: .destructive) { linkToRemove = link } label: { Image(systemName: "link.badge.minus") }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("Forget link")
                        }
                    }
                } header: {
                    Text("Climbing links")
                } footer: {
                    Text("Forgetting a link does not delete the Calendar event or Todoist task.")
                }
            }
            Section {
                Text("Connect providers, change credentials, and choose the Personal calendar, Gmail account, and Todoist project from Workspace on your Mac.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Connections")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await store.refreshIntegrations() } } label: {
                    if store.isLoading(.integrations) { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                }
                .disabled(!store.hasWorkspaceAccess || store.isLoading(.integrations))
            }
        }
        .refreshable { await store.refreshIntegrations() }
        .task { await store.load(.integrations) }
        .confirmationDialog("Forget this Workspace link?", isPresented: Binding(get: { linkToRemove != nil }, set: { if !$0 { linkToRemove = nil } }), titleVisibility: .visible) {
            Button("Forget link", role: .destructive) {
                guard let link = linkToRemove else { return }
                linkToRemove = nil
                Task { await store.unlinkIntegration(id: link.id) }
            }
            Button("Keep link", role: .cancel) { linkToRemove = nil }
        } message: { Text("The external item remains unchanged.") }
    }

    private func linkTitle(_ link: IntegrationLink) -> String {
        switch link.entityKind {
        case .goal: return store.climbing.goals.first(where: { $0.id == link.entityId })?.title ?? "Climbing goal"
        case .plan: return store.climbing.plans.first(where: { $0.id == link.entityId })?.title ?? "Climbing plan"
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
            return selected.isEmpty ? "Connected" : selected.map(\.name).joined(separator: ", ")
        }
        return state.configured ? "Ready to connect on Mac" : "Set up on Mac"
    }
}

private struct PairingSyncView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @State private var showingPicker = false
    @State private var confirmUnpair = false

    var body: some View {
        Form {
            EditorErrorSection(area: .pairing)
            Section("Mac bridge") {
                LabeledContent("Status", value: store.isPaired ? "Paired" : "Not paired")
                if let credentials = store.credentials {
                    LabeledContent("Mac", value: credentials.url.host ?? credentials.url.absoluteString)
                    LabeledContent("Access", value: credentials.scope == .workspace ? "Full Workspace" : "Health")
                }
                Text(store.status).font(.subheadline).foregroundStyle(.secondary)
                Button { showingPicker = true } label: {
                    Label(store.isPaired ? "Choose a new pairing file" : "Choose pairing file", systemImage: "doc.badge.plus")
                }
                .disabled(store.isLoading(.pairing))
            }

            if store.isPaired {
                Section("Sync") {
                    Button { Task { await store.refreshAll() } } label: { Label("Refresh Workspace", systemImage: "arrow.clockwise") }
                        .disabled(store.busy || !store.hasWorkspaceAccess)
                    Button { Task { await store.syncHealth() } } label: { Label("Sync Apple Health", systemImage: "heart.circle") }
                        .disabled(store.busy)
                }
                Section {
                    Button("Unpair this iPhone", role: .destructive) { confirmUnpair = true }
                        .disabled(store.isLoading(.pairing))
                }
            }
        }
        .navigationTitle("Pairing & Sync")
        .fileImporter(isPresented: $showingPicker, allowedContentTypes: [.json]) { result in
            switch result {
            case .success(let url): Task { await store.pair(url) }
            case .failure(let error): store.error = error.localizedDescription
            }
        }
        .confirmationDialog("Unpair this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { Task { await store.unpair() } }
                .disabled(store.isLoading(.pairing))
            Button("Stay paired", role: .cancel) { }
        } message: { Text("This immediately removes the token and cached data from this iPhone, then asks your Mac to revoke the pairing. If the Mac cannot confirm, Workspace tells you how to invalidate the token there.") }
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
