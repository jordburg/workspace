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

struct WorkspaceRootView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: WorkspaceTab = .today
    @State private var selectedDay = Date()

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack {
                TodayView(
                    selectedDay: $selectedDay,
                    openClimbing: { tab = .climbing },
                    openHealth: { tab = .health },
                    openPairing: { tab = .more }
                )
            }
            .tabItem { Label("Today", systemImage: "sun.max") }
            .tag(WorkspaceTab.today)

            NavigationStack {
                InboxView(selectedDay: $selectedDay, openPairing: { tab = .more })
            }
            .tabItem { Label("Inbox", systemImage: "tray") }
            .tag(WorkspaceTab.inbox)

            NavigationStack {
                ClimbingView(selectedDay: $selectedDay, openPairing: { tab = .more })
            }
            .tabItem { Label("Climbing", systemImage: "mountain.2") }
            .tag(WorkspaceTab.climbing)

            NavigationStack {
                HealthWorkspaceView(selectedDay: $selectedDay, openPairing: { tab = .more })
            }
            .tabItem { Label("Health", systemImage: "heart") }
            .tag(WorkspaceTab.health)

            NavigationStack {
                MoreView()
            }
            .tabItem { Label("More", systemImage: "ellipsis") }
            .tag(WorkspaceTab.more)
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
        if let error = store.error {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Workspace needs attention", systemImage: "exclamationmark.triangle.fill")
                        .font(.headline)
                        .foregroundStyle(.orange)
                    Text(error).font(.subheadline)
                    Button("Dismiss") { store.clearError() }
                        .font(.subheadline.weight(.semibold))
                }
                .accessibilityElement(children: .combine)
            }
        } else if !store.isPaired {
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
}

private struct RemoteEventDraft: Identifiable {
    let id = UUID()
    let event: RemoteEvent?
    let day: String
    let presetTitle: String?
    let presetLocation: String?
    let link: IntegrationLinkRequest?
}

struct TodayView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Binding var selectedDay: Date
    let openClimbing: () -> Void
    let openHealth: () -> Void
    let openPairing: () -> Void

    @State private var area: MobileAreaFilter = .all
    @State private var itemDraft: WorkspaceItem?
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
            .sorted { ($0.dueTime ?? "99:99", -$0.priority) < ($1.dueTime ?? "99:99", -$1.priority) }
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
            Section {
                WeekDayPicker(selection: $selectedDay)
            }

            Section("Priorities") {
                if priorities.isEmpty {
                    EmptyRow(icon: "sparkles", title: "What would make this a good day?", detail: "Choose one important thing to move forward.")
                } else {
                    ForEach(priorities) { item in
                        Button { itemDraft = item } label: {
                            HStack(spacing: 12) {
                                Button {
                                    var changed = item
                                    changed.done.toggle()
                                    Task { await store.upsertWorkspaceItem(changed) }
                                } label: {
                                    Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                                        .font(.title3)
                                        .foregroundStyle(item.done ? Color.teal : Color.secondary)
                                }
                                .buttonStyle(.plain)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.title).strikethrough(item.done)
                                    Text(item.area == .personal ? "Personal" : "Independent work")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                Button { itemDraft = .new(kind: .priority, area: defaultArea, date: day) } label: {
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
                        itemDraft = plan
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
                    Button("Priority", systemImage: "sparkles") { itemDraft = .new(kind: .priority, area: defaultArea, date: day) }
                    Button("Plan", systemImage: "calendar.badge.plus") {
                        var plan = WorkspaceItem.new(kind: .plan, area: defaultArea, date: day)
                        plan.time = "09:00"
                        itemDraft = plan
                    }
                    Button("Thought", systemImage: "tray.and.arrow.down") { itemDraft = .new(kind: .note, area: defaultArea) }
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
        .sheet(item: $itemDraft) { item in
            WorkspaceItemEditor(item: item)
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
        case .local(let item): itemDraft = item
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
    @State private var itemDraft: WorkspaceItem?
    @State private var taskDraft: RemoteTaskDraft?
    @State private var noteToDelete: WorkspaceItem?
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
                        Button { itemDraft = note } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(note.title).foregroundStyle(.primary)
                                Text(note.area == .personal ? "Personal" : "Independent work")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            Button { makePriority(note) } label: { Label("Prioritize", systemImage: "sparkles") }
                                .tint(.teal)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) { noteToDelete = note } label: { Label("Delete", systemImage: "trash") }
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
        .refreshable { await store.refreshAll() }
        .sheet(item: $itemDraft) { WorkspaceItemEditor(item: $0) }
        .sheet(item: $taskDraft) { TodoistTaskEditor(draft: $0) }
        .confirmationDialog(
            noteToDelete.map { "Delete “\($0.title)”?" } ?? "Delete this thought?",
            isPresented: Binding(get: { noteToDelete != nil }, set: { if !$0 { noteToDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete from Workspace", role: .destructive) {
                guard let note = noteToDelete else { return }
                noteToDelete = nil
                Task { await store.removeWorkspaceItem(id: note.id) }
            }
            Button("Cancel", role: .cancel) { noteToDelete = nil }
        } message: { Text("This removes the saved thought from your Mac.") }
    }

    private func saveCapture() {
        let text = capture.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        var note = WorkspaceItem.new(kind: .note)
        note.title = text
        Task {
            await store.upsertWorkspaceItem(note)
            if store.workspace.items.contains(where: { $0.id == note.id }) { capture = "" }
        }
    }

    private func makePriority(_ note: WorkspaceItem) {
        var priority = note
        priority.kind = .priority
        priority.date = WorkspaceFormat.dayKey(selectedDay)
        priority.time = nil
        priority.endTime = nil
        priority.done = false
        Task { await store.upsertWorkspaceItem(priority) }
    }
}

// MARK: - Daily item editor

private struct WorkspaceItemEditor: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    let original: WorkspaceItem
    @State private var value: WorkspaceItem
    @State private var deleteRequested = false

    init(item: WorkspaceItem) {
        original = item
        _value = State(initialValue: item)
    }

    private var isNew: Bool { !store.workspace.items.contains { $0.id == original.id } }
    private var dirty: Bool { value != original }

    var body: some View {
        NavigationStack {
            Form {
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
                        await store.removeWorkspaceItem(id: value.id)
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
        let priorRevision = store.workspace.revision
        Task {
            await store.upsertWorkspaceItem(expected)
            if store.workspace.revision > priorRevision && store.workspace.items.contains(where: { $0 == expected }) { dismiss() }
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

    init(draft: RemoteTaskDraft) {
        self.draft = draft
        _title = State(initialValue: draft.task?.title ?? "")
        _dueDate = State(initialValue: draft.task?.dueDate ?? draft.day)
        _hasDueDate = State(initialValue: draft.task?.dueDate != nil || draft.task == nil)
        _sourceId = State(initialValue: draft.task?.sourceId ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Task", text: $title, axis: .vertical).lineLimit(2...6)
                    if draft.task == nil {
                        Picker("Project", selection: $sourceId) {
                            ForEach(availableSources) { source in Text(source.name).tag(source.id) }
                        }
                    }
                    Toggle("Due date", isOn: $hasDueDate)
                    if hasDueDate {
                        DayField("Date", value: $dueDate)
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
        let oldTasks = store.integrations.tasks
        let mutation = IntegrationMutation(
            provider: .todoist, action: action, id: draft.task?.id, version: draft.task?.version,
            sourceId: action == .create ? effectiveSourceId : nil, anchorDate: draft.day,
            title: action == .delete ? nil : title.trimmingCharacters(in: .whitespacesAndNewlines),
            date: action == .delete ? nil : (hasDueDate ? dueDate : nil), link: action == .create ? draft.link : nil
        )
        Task {
            await store.mutateIntegration(mutation)
            let succeeded: Bool
            switch action {
            case .create: succeeded = store.integrations.tasks != oldTasks
            case .update: succeeded = store.integrations.tasks.first(where: { $0.id == draft.task?.id })?.title == title.trimmingCharacters(in: .whitespacesAndNewlines)
            case .delete, .complete: succeeded = !store.integrations.tasks.contains(where: { $0.id == draft.task?.id })
            }
            if succeeded { dismiss() }
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
        let mutation = IntegrationMutation(
            provider: .google, action: action, id: event?.id, version: event?.version,
            anchorDate: draft.day, title: action == .delete ? nil : title.trimmingCharacters(in: .whitespacesAndNewlines),
            date: action == .delete ? nil : startDate, endDate: action == .delete ? nil : normalizedEndDate,
            time: action == .delete || allDay ? nil : startTime, endTime: action == .delete || allDay ? nil : endTime,
            allDay: action == .delete ? nil : allDay, location: action == .delete ? nil : location,
            link: action == .create ? draft.link : nil
        )
        Task {
            await store.mutateIntegration(mutation)
            switch action {
            case .create:
                if store.integrations.events.contains(where: { $0.title == title && $0.startDate == startDate }) { dismiss() }
            case .update:
                if store.integrations.events.first(where: { $0.id == event?.id })?.version != event?.version { dismiss() }
            case .delete:
                if !store.integrations.events.contains(where: { $0.id == event?.id }) { dismiss() }
            case .complete: break
            }
        }
    }

    private var normalizedEndDate: String {
        if allDay && endDate <= startDate { return shiftDay(startDate, by: 1) }
        return endDate < startDate ? startDate : endDate
    }
}

