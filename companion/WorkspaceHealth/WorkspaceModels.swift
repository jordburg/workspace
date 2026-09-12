import Foundation

// MARK: - Shared values

enum WorkspaceArea: String, CaseIterable, Hashable, Sendable {
    case workspace
    case climbing
    case finance
    case writing
    case integrations
    case health
    case pairing
}

enum LifeArea: String, Codable, CaseIterable, Hashable, Sendable {
    case personal
    case independent
}

struct UnifiedHealthWorkout: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let start: Date
    let timeZoneIdentifier: String?
    let snapshotTimeZoneIdentifier: String?
    let minutes: Double
    let activity: String
    let source: String

    var timeZone: TimeZone {
        WorkspaceFormat.resolvedTimeZone(
            primaryIdentifier: timeZoneIdentifier,
            fallbackIdentifier: snapshotTimeZoneIdentifier
        )
    }
}

enum WorkspaceFormat {
    static func resolvedTimeZone(
        primaryIdentifier: String?,
        fallbackIdentifier: String?
    ) -> TimeZone {
        primaryIdentifier.flatMap(timeZone(fromWireIdentifier:))
            ?? fallbackIdentifier.flatMap(timeZone(fromWireIdentifier:))
            ?? .current
    }

    /// Returns a timezone spelling accepted by the bridge's JavaScript Intl
    /// validator. Foundation represents fixed offsets as `GMT-0700`, while
    /// Intl uses `-07:00`; named IANA zones are preserved so DST rules survive.
    static func wireTimeZoneIdentifier(_ timeZone: TimeZone, at date: Date = Date()) -> String {
        let identifier = timeZone.identifier
        if identifier == "GMT" { return "UTC" }
        if TimeZone.knownTimeZoneIdentifiers.contains(identifier), fixedOffsetSeconds(from: identifier) == nil {
            return identifier
        }
        return wireOffsetIdentifier(secondsFromGMT: timeZone.secondsFromGMT(for: date))
    }

    static func wireTimeZoneIdentifier(_ identifier: String?, at date: Date) -> String? {
        guard let identifier, !identifier.isEmpty else { return nil }
        if fixedOffsetSeconds(from: identifier) == nil,
           TimeZone.knownTimeZoneIdentifiers.contains(identifier) {
            return identifier
        }
        guard let timeZone = timeZone(fromWireIdentifier: identifier) else { return nil }
        return wireTimeZoneIdentifier(timeZone, at: date)
    }

    static func timeZone(fromWireIdentifier identifier: String) -> TimeZone? {
        if let seconds = fixedOffsetSeconds(from: identifier) {
            return TimeZone(secondsFromGMT: seconds)
        }
        return TimeZone(identifier: identifier)
    }

    private static func fixedOffsetSeconds(from identifier: String) -> Int? {
        var value = identifier.uppercased()
        if value.hasPrefix("GMT") || value.hasPrefix("UTC") { value.removeFirst(3) }
        guard let sign = value.first, sign == "+" || sign == "-" else { return nil }
        value.removeFirst()

        let hourText: String
        let minuteText: String
        if let colon = value.firstIndex(of: ":") {
            hourText = String(value[..<colon])
            minuteText = String(value[value.index(after: colon)...])
            guard minuteText.count == 2 else { return nil }
        } else if value.count <= 2 {
            hourText = value
            minuteText = "0"
        } else if value.count == 3 || value.count == 4 {
            hourText = String(value.dropLast(2))
            minuteText = String(value.suffix(2))
        } else {
            return nil
        }
        guard !hourText.isEmpty,
              hourText.allSatisfy(\.isNumber),
              minuteText.allSatisfy(\.isNumber),
              let hours = Int(hourText),
              let minutes = Int(minuteText),
              hours <= 23,
              minutes < 60 else { return nil }
        let seconds = (hours * 60 + minutes) * 60
        return sign == "-" ? -seconds : seconds
    }

    private static func wireOffsetIdentifier(secondsFromGMT: Int) -> String {
        let roundedMinutes = Int((Double(abs(secondsFromGMT)) / 60).rounded())
        let hours = roundedMinutes / 60
        let minutes = roundedMinutes % 60
        let sign = secondsFromGMT < 0 ? "-" : "+"
        return String(format: "%@%02d:%02d", sign, hours, minutes)
    }

    static func dayKey(
        _ date: Date = Date(),
        timeZoneIdentifier: String? = nil,
        fallbackTimeZoneIdentifier: String? = nil
    ) -> String {
        dayKey(
            date,
            in: resolvedTimeZone(
                primaryIdentifier: timeZoneIdentifier,
                fallbackIdentifier: fallbackTimeZoneIdentifier
            )
        )
    }

    static func dayKey(_ date: Date, in timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    static func timeLabel(_ date: Date, in timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.timeZone = timeZone
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    static func preferredHealthWorkouts(
        on day: String,
        local: [UnifiedHealthWorkout],
        remote: [UnifiedHealthWorkout]
    ) -> [UnifiedHealthWorkout] {
        var seen = Set<String>()
        let preferred = (local + remote).filter {
            seen.insert($0.id.lowercased()).inserted
        }
        return preferred.filter { dayKey($0.start, in: $0.timeZone) == day }
    }

    static func timestamp(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

private extension KeyedEncodingContainer {
    mutating func encodeNullable<T: Encodable>(_ value: T?, forKey key: Key) throws {
        if let value {
            try encode(value, forKey: key)
        } else {
            try encodeNil(forKey: key)
        }
    }
}

// MARK: - Daily workspace

enum WorkspaceItemKind: String, Codable, CaseIterable, Hashable, Sendable {
    case priority
    case plan
    case note
}

struct WorkspaceItem: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var kind: WorkspaceItemKind
    var title: String
    var area: LifeArea
    var date: String?
    var time: String?
    var endTime: String?
    var done: Bool

    static func new(
        kind: WorkspaceItemKind,
        area: LifeArea = .personal,
        date: String? = nil
    ) -> WorkspaceItem {
        WorkspaceItem(
            id: UUID().uuidString.lowercased(),
            kind: kind,
            title: "",
            area: area,
            date: kind == .note ? nil : (date ?? WorkspaceFormat.dayKey()),
            time: nil,
            endTime: nil,
            done: false
        )
    }

    enum CodingKeys: String, CodingKey { case id, kind, title, area, date, time, endTime, done }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(kind, forKey: .kind)
        try values.encode(title, forKey: .title)
        try values.encode(area, forKey: .area)
        try values.encodeNullable(date, forKey: .date)
        try values.encodeNullable(time, forKey: .time)
        try values.encodeNullable(endTime, forKey: .endTime)
        try values.encode(done, forKey: .done)
    }
}

struct WorkspaceState: Codable, Equatable, Sendable {
    var version: Int
    var revision: Int
    var items: [WorkspaceItem]

    static let empty = WorkspaceState(version: 1, revision: 0, items: [])
}

// MARK: - Climbing

enum GradeSystem: String, Codable, CaseIterable, Hashable, Sendable {
    case vScale = "v-scale"
    case font
    case yds
    case french
    case uiaa
    case uk
    case gym
    case custom
}

enum ClimbDiscipline: String, Codable, CaseIterable, Hashable, Sendable {
    case boulder
    case route
}

enum RopeStyle: String, Codable, CaseIterable, Hashable, Sendable {
    case topRope = "top-rope"
    case sportLead = "sport-lead"
    case tradLead = "trad-lead"
    case follow
    case autoBelay = "auto-belay"
}

enum ClimbOutcome: String, Codable, CaseIterable, Hashable, Sendable {
    case flash
    case onsight
    case redpoint
    case send
    case repeatClimb = "repeat"
    case attempt
}

enum ClimbingEnvironment: String, Codable, CaseIterable, Hashable, Sendable {
    case indoor
    case outdoor
}

enum ClimbingFocus: String, Codable, CaseIterable, Hashable, Sendable {
    case bouldering
    case routes
    case mixed
    case training
    case other
}

enum ClimbingReadiness: String, Codable, CaseIterable, Hashable, Sendable {
    case fresh
    case steady
    case tired
    case sore
}

enum RoutineFocus: String, Codable, CaseIterable, Hashable, Sendable {
    case technique
    case strength
    case power
    case powerEndurance = "power-endurance"
    case endurance
    case mobility
    case recovery
    case general
}

enum RoutineStepStatus: String, Codable, CaseIterable, Hashable, Sendable {
    case notLogged = "not-logged"
    case done
    case skipped
    case modified
}

enum ClimbingGoalKind: String, Codable, CaseIterable, Hashable, Sendable {
    case consistency
    case project
    case skill
    case training
    case custom
}

enum ClimbingGoalStatus: String, Codable, CaseIterable, Hashable, Sendable {
    case active
    case paused
    case completed
}

enum ClimbingPlanStatus: String, Codable, CaseIterable, Hashable, Sendable {
    case planned
    case logged
    case cancelled
}

struct Climb: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var discipline: ClimbDiscipline
    var ropeStyle: RopeStyle?
    var gradeSystem: GradeSystem?
    var grade: String?
    var outcome: ClimbOutcome
    var attempts: Int?
    var notes: String

    static func new(discipline: ClimbDiscipline = .boulder) -> Climb {
        Climb(
            id: UUID().uuidString.lowercased(),
            name: "",
            discipline: discipline,
            ropeStyle: discipline == .route ? .topRope : nil,
            gradeSystem: nil,
            grade: nil,
            outcome: .attempt,
            attempts: 1,
            notes: ""
        )
    }

    enum CodingKeys: String, CodingKey { case id, name, discipline, ropeStyle, gradeSystem, grade, outcome, attempts, notes }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(name, forKey: .name)
        try values.encode(discipline, forKey: .discipline)
        try values.encodeNullable(ropeStyle, forKey: .ropeStyle)
        try values.encodeNullable(gradeSystem, forKey: .gradeSystem)
        try values.encodeNullable(grade, forKey: .grade)
        try values.encode(outcome, forKey: .outcome)
        try values.encodeNullable(attempts, forKey: .attempts)
        try values.encode(notes, forKey: .notes)
    }
}

struct ClimbingRoutineStep: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var prescription: String
    var rest: String
    var notes: String

    static func new() -> ClimbingRoutineStep {
        ClimbingRoutineStep(id: UUID().uuidString.lowercased(), name: "", prescription: "", rest: "", notes: "")
    }
}

struct ClimbingRoutineExecutionStep: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var prescription: String
    var rest: String
    var notes: String
    var status: RoutineStepStatus
    var result: String
}

struct ClimbingRoutine: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var focus: RoutineFocus
    var description: String
    var estimatedMinutes: Int?
    var steps: [ClimbingRoutineStep]
    var version: Int
    var archived: Bool
    var updatedAt: String

    static func new() -> ClimbingRoutine {
        ClimbingRoutine(
            id: UUID().uuidString.lowercased(),
            title: "",
            focus: .general,
            description: "",
            estimatedMinutes: nil,
            steps: [.new()],
            version: 1,
            archived: false,
            updatedAt: WorkspaceFormat.timestamp()
        )
    }

    enum CodingKeys: String, CodingKey { case id, title, focus, description, estimatedMinutes, steps, version, archived, updatedAt }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(title, forKey: .title)
        try values.encode(focus, forKey: .focus)
        try values.encode(description, forKey: .description)
        try values.encodeNullable(estimatedMinutes, forKey: .estimatedMinutes)
        try values.encode(steps, forKey: .steps)
        try values.encode(version, forKey: .version)
        try values.encode(archived, forKey: .archived)
        try values.encode(updatedAt, forKey: .updatedAt)
    }
}

struct ClimbingRoutineExecution: Codable, Hashable, Sendable {
    var routineId: String
    var version: Int
    var title: String
    var focus: RoutineFocus
    var description: String
    var estimatedMinutes: Int?
    var steps: [ClimbingRoutineExecutionStep]

    init(snapshotOf routine: ClimbingRoutine) {
        routineId = routine.id
        version = routine.version
        title = routine.title
        focus = routine.focus
        description = routine.description
        estimatedMinutes = routine.estimatedMinutes
        steps = routine.steps.map {
            ClimbingRoutineExecutionStep(
                id: $0.id,
                name: $0.name,
                prescription: $0.prescription,
                rest: $0.rest,
                notes: $0.notes,
                status: .notLogged,
                result: ""
            )
        }
    }

    init(
        routineId: String,
        version: Int,
        title: String,
        focus: RoutineFocus,
        description: String,
        estimatedMinutes: Int?,
        steps: [ClimbingRoutineExecutionStep]
    ) {
        self.routineId = routineId
        self.version = version
        self.title = title
        self.focus = focus
        self.description = description
        self.estimatedMinutes = estimatedMinutes
        self.steps = steps
    }

    enum CodingKeys: String, CodingKey { case routineId, version, title, focus, description, estimatedMinutes, steps }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(routineId, forKey: .routineId)
        try values.encode(version, forKey: .version)
        try values.encode(title, forKey: .title)
        try values.encode(focus, forKey: .focus)
        try values.encode(description, forKey: .description)
        try values.encodeNullable(estimatedMinutes, forKey: .estimatedMinutes)
        try values.encode(steps, forKey: .steps)
    }
}

struct ClimbingSession: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var date: String
    var environment: ClimbingEnvironment
    var venue: String
    var focus: ClimbingFocus
    var durationMinutes: Int?
    var effort: Int?
    var readiness: ClimbingReadiness?
    var notes: String
    var climbs: [Climb]
    var routine: ClimbingRoutineExecution?
    var planId: String?
    var healthWorkoutId: String?
    var deletedAt: String?
    var createdAt: String
    var updatedAt: String

    static func new(date: String = WorkspaceFormat.dayKey()) -> ClimbingSession {
        let now = WorkspaceFormat.timestamp()
        return ClimbingSession(
            id: UUID().uuidString.lowercased(), date: date, environment: .indoor, venue: "", focus: .bouldering,
            durationMinutes: nil, effort: nil, readiness: nil, notes: "", climbs: [], routine: nil,
            planId: nil, healthWorkoutId: nil, deletedAt: nil, createdAt: now, updatedAt: now
        )
    }

    enum CodingKeys: String, CodingKey { case id, date, environment, venue, focus, durationMinutes, effort, readiness, notes, climbs, routine, planId, healthWorkoutId, deletedAt, createdAt, updatedAt }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(date, forKey: .date)
        try values.encode(environment, forKey: .environment)
        try values.encode(venue, forKey: .venue)
        try values.encode(focus, forKey: .focus)
        try values.encodeNullable(durationMinutes, forKey: .durationMinutes)
        try values.encodeNullable(effort, forKey: .effort)
        try values.encodeNullable(readiness, forKey: .readiness)
        try values.encode(notes, forKey: .notes)
        try values.encode(climbs, forKey: .climbs)
        try values.encodeNullable(routine, forKey: .routine)
        try values.encodeNullable(planId, forKey: .planId)
        try values.encodeNullable(healthWorkoutId, forKey: .healthWorkoutId)
        try values.encodeNullable(deletedAt, forKey: .deletedAt)
        try values.encode(createdAt, forKey: .createdAt)
        try values.encode(updatedAt, forKey: .updatedAt)
    }
}

struct ClimbingGoal: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var kind: ClimbingGoalKind
    var description: String
    var status: ClimbingGoalStatus
    var archivedAt: String?
    var progress: Int
    var nextStep: String
    var startDate: String?
    var targetDate: String?
    var sessionTarget: Int?
    var venue: String?
    var gradeSystem: GradeSystem?
    var grade: String?
    var routineId: String?
    var updatedAt: String

    static func new() -> ClimbingGoal {
        ClimbingGoal(
            id: UUID().uuidString.lowercased(), title: "", kind: .custom, description: "", status: .active,
            archivedAt: nil, progress: 0, nextStep: "", startDate: nil, targetDate: nil, sessionTarget: nil,
            venue: nil, gradeSystem: nil, grade: nil, routineId: nil, updatedAt: WorkspaceFormat.timestamp()
        )
    }

    enum CodingKeys: String, CodingKey { case id, title, kind, description, status, archivedAt, progress, nextStep, startDate, targetDate, sessionTarget, venue, gradeSystem, grade, routineId, updatedAt }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(title, forKey: .title)
        try values.encode(kind, forKey: .kind)
        try values.encode(description, forKey: .description)
        try values.encode(status, forKey: .status)
        try values.encodeNullable(archivedAt, forKey: .archivedAt)
        try values.encode(progress, forKey: .progress)
        try values.encode(nextStep, forKey: .nextStep)
        try values.encodeNullable(startDate, forKey: .startDate)
        try values.encodeNullable(targetDate, forKey: .targetDate)
        try values.encodeNullable(sessionTarget, forKey: .sessionTarget)
        try values.encodeNullable(venue, forKey: .venue)
        try values.encodeNullable(gradeSystem, forKey: .gradeSystem)
        try values.encodeNullable(grade, forKey: .grade)
        try values.encodeNullable(routineId, forKey: .routineId)
        try values.encode(updatedAt, forKey: .updatedAt)
    }
}

struct ClimbingPlan: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var date: String
    var startTime: String?
    var endDate: String?
    var endTime: String?
    var environment: ClimbingEnvironment
    var venue: String
    var focus: ClimbingFocus
    var goalId: String?
    var routine: ClimbingRoutineExecution?
    var status: ClimbingPlanStatus
    var sessionId: String?
    var createdAt: String
    var updatedAt: String

    static func new(date: String = WorkspaceFormat.dayKey()) -> ClimbingPlan {
        let now = WorkspaceFormat.timestamp()
        return ClimbingPlan(
            id: UUID().uuidString.lowercased(), title: "Climbing", date: date,
            startTime: nil, endDate: nil, endTime: nil, environment: .indoor, venue: "", focus: .bouldering,
            goalId: nil, routine: nil, status: .planned, sessionId: nil, createdAt: now, updatedAt: now
        )
    }

    enum CodingKeys: String, CodingKey { case id, title, date, startTime, endDate, endTime, environment, venue, focus, goalId, routine, status, sessionId, createdAt, updatedAt }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(title, forKey: .title)
        try values.encode(date, forKey: .date)
        try values.encodeNullable(startTime, forKey: .startTime)
        try values.encodeNullable(endDate, forKey: .endDate)
        try values.encodeNullable(endTime, forKey: .endTime)
        try values.encode(environment, forKey: .environment)
        try values.encode(venue, forKey: .venue)
        try values.encode(focus, forKey: .focus)
        try values.encodeNullable(goalId, forKey: .goalId)
        try values.encodeNullable(routine, forKey: .routine)
        try values.encode(status, forKey: .status)
        try values.encodeNullable(sessionId, forKey: .sessionId)
        try values.encode(createdAt, forKey: .createdAt)
        try values.encode(updatedAt, forKey: .updatedAt)
    }
}

struct ClimbingState: Codable, Equatable, Sendable {
    var version: Int
    var revision: Int
    var sessions: [ClimbingSession]
    var goals: [ClimbingGoal]
    var routines: [ClimbingRoutine]
    var plans: [ClimbingPlan]

    static let empty = ClimbingState(version: 1, revision: 0, sessions: [], goals: [], routines: [], plans: [])

    enum CodingKeys: String, CodingKey { case version, revision, sessions, goals, routines, plans }
    init(version: Int, revision: Int, sessions: [ClimbingSession], goals: [ClimbingGoal], routines: [ClimbingRoutine], plans: [ClimbingPlan]) {
        self.version = version
        self.revision = revision
        self.sessions = sessions
        self.goals = goals
        self.routines = routines
        self.plans = plans
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        revision = try values.decode(Int.self, forKey: .revision)
        sessions = try values.decode([ClimbingSession].self, forKey: .sessions)
        goals = try values.decode([ClimbingGoal].self, forKey: .goals)
        routines = try values.decode([ClimbingRoutine].self, forKey: .routines)
        plans = try values.decodeIfPresent([ClimbingPlan].self, forKey: .plans) ?? []
    }
}

// MARK: - Health view returned by the Mac

enum HealthWorkoutActivity: String, Codable, CaseIterable, Hashable, Sendable {
    case climbing
    case walking
    case running
    case cycling
    case swimming
    case hiking
    case yoga
    case traditionalStrengthTraining = "traditional-strength-training"
    case functionalStrengthTraining = "functional-strength-training"
    case hiit
    case other
}

struct PhoneHealthDay: Codable, Identifiable, Hashable, Sendable {
    var date: String
    var steps: Double?
    var sleepMinutes: Double?
    var restingHeartRate: Double?
    var weightKg: Double?
    var id: String { date }
}

struct PhoneHealthWorkout: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var start: Date
    var end: Date
    var minutes: Double
    var activity: HealthWorkoutActivity
    var sourceId: String?
    var sourceName: String?
    var timeZone: String?
}

struct PhoneHealthSnapshot: Codable, Hashable, Sendable {
    var version: Int
    var id: String
    var generatedAt: Date
    var timeZone: String
    var from: String
    var to: String
    var days: [PhoneHealthDay]
    var workouts: [PhoneHealthWorkout]
}

struct PhoneHealthView: Decodable, Hashable, Sendable {
    var enabled: Bool
    var online: Bool
    var paired: Bool
    var phoneScope: BridgeScope?
    var endpoint: String?
    var addresses: [String]
    var error: String?
    var lastSynced: String?
    var snapshot: PhoneHealthSnapshot?
    var commands: [WeightCommand]
}

// MARK: - Finance

enum FinanceEnvironment: String, Codable, Hashable, Sendable {
    case production
    case sandbox
}

struct BankAccount: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var mask: String
    var type: String
    var subtype: String
    var currency: String?
    var current: Double?
    var available: Double?
    var selected: Bool
    var blocked: Bool
}

struct BankConnection: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var accounts: [BankAccount]
    var lastSynced: String?
    var error: String?
    var updateStatus: String?
}

struct FinanceTransaction: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var itemId: String
    var accountId: String
    var date: String
    var name: String
    var amount: Double
    var currency: String?
    var pending: Bool
    var category: String
    var pendingId: String?
}

struct TransactionNote: Codable, Hashable, Sendable {
    var category: String
    var note: String
    var excludeFromSpending: Bool
    var revision: Int
}

struct FinanceNoteInput: Codable, Hashable, Sendable {
    var transactionId: String
    var category: String
    var note: String
    var excludeFromSpending: Bool
    var revision: Int
}

struct FinanceView: Codable, Equatable, Sendable {
    var configured: Bool
    var environment: FinanceEnvironment?
    var banks: [BankConnection]
    var transactions: [FinanceTransaction]
    var annotations: [String: TransactionNote]

    static let empty = FinanceView(configured: false, environment: nil, banks: [], transactions: [], annotations: [:])
}

// MARK: - Writing

enum SiteThread: String, Codable, CaseIterable, Hashable, Sendable {
    case engineering
    case fieldwork
    case research
    case writing
}

enum SiteKind: String, Codable, CaseIterable, Hashable, Sendable {
    case writing
    case idea
    case work
}

struct WritingExportReceipt: Codable, Hashable, Sendable {
    var file: String
    var hash: String
    var order: Int
    var at: String
}

struct WritingInput: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var revision: Int
    var slug: String
    var title: String
    var summary: String
    var body: String
    var timeframe: String
    var kind: SiteKind
    var format: String
    var primaryThread: SiteThread
    var threads: [SiteThread]
    var topics: [String]
    var relatedEntries: [String]

    static func new() -> WritingInput {
        WritingInput(
            id: UUID().uuidString.lowercased(), revision: 0, slug: "", title: "", summary: "", body: "",
            timeframe: "", kind: .writing, format: "", primaryThread: .writing,
            threads: [.writing], topics: [], relatedEntries: []
        )
    }
}

struct WritingDraft: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var revision: Int
    var slug: String
    var title: String
    var summary: String
    var body: String
    var timeframe: String
    var kind: SiteKind
    var format: String
    var primaryThread: SiteThread
    var threads: [SiteThread]
    var topics: [String]
    var relatedEntries: [String]
    var updatedAt: String
    var exported: WritingExportReceipt?

    var input: WritingInput {
        WritingInput(
            id: id, revision: revision, slug: slug, title: title, summary: summary, body: body,
            timeframe: timeframe, kind: kind, format: format, primaryThread: primaryThread,
            threads: threads, topics: topics, relatedEntries: relatedEntries
        )
    }
}

struct SiteEntry: Codable, Identifiable, Hashable, Sendable {
    var slug: String
    var title: String
    var summary: String
    var kind: String
    var order: Int
    var draft: Bool
    var primaryThread: String
    var id: String { slug }
}

struct WritingView: Codable, Equatable, Sendable {
    var repository: String
    var available: Bool
    var error: String?
    var entries: [SiteEntry]
    var drafts: [WritingDraft]
    var pendingExports: [String]

    static let empty = WritingView(repository: "", available: false, error: nil, entries: [], drafts: [], pendingExports: [])
}

// MARK: - Todoist and Google Calendar

enum IntegrationProvider: String, Codable, CaseIterable, Hashable, Sendable {
    case todoist
    case google
}

struct IntegrationSource: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var area: LifeArea
    var blocked: Bool
    var parentId: String?
}

struct RemoteTask: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var sourceId: String
    var sourceName: String
    var title: String
    var area: LifeArea
    var dueDate: String?
    var dueTime: String?
    var deadline: String?
    var recurring: Bool
    var priority: Int
    var version: String
    var parentId: String?
    var url: String
}

struct RemoteEvent: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var sourceId: String
    var sourceName: String
    var title: String
    var area: LifeArea
    var startDate: String
    var endDate: String
    var startTime: String?
    var endTime: String?
    var allDay: Bool
    var version: String
    var editable: Bool
    var recurring: Bool
    var url: String
    var location: String
}

struct IntegrationSelection: Codable, Hashable, Sendable {
    var id: String
    var area: LifeArea
}

struct IntegrationProviderState: Codable, Hashable, Sendable {
    var connected: Bool
    var configured: Bool
    var sources: [IntegrationSource]
    var selected: [IntegrationSelection]
    var lastSynced: String?
    var error: String?
}

enum IntegrationEntityKind: String, Codable, Hashable, Sendable {
    case goal
    case plan
}

enum IntegrationLinkRole: String, Codable, Hashable, Sendable {
    case goalNextStep = "goal-next-step"
    case scheduledSession = "scheduled-session"
}

struct IntegrationLink: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var entityKind: IntegrationEntityKind
    var entityId: String
    var role: IntegrationLinkRole
    var provider: IntegrationProvider
    var remoteId: String
    var requestId: String
    var createdAt: String
}

struct IntegrationRange: Codable, Hashable, Sendable {
    var from: String
    var to: String
    var timeZone: String
}

struct IntegrationView: Codable, Equatable, Sendable {
    var todoist: IntegrationProviderState
    var google: IntegrationProviderState
    var tasks: [RemoteTask]
    var events: [RemoteEvent]
    var links: [IntegrationLink]
    var range: IntegrationRange?

    static let emptyProvider = IntegrationProviderState(connected: false, configured: false, sources: [], selected: [], lastSynced: nil, error: nil)
    static let empty = IntegrationView(todoist: emptyProvider, google: emptyProvider, tasks: [], events: [], links: [], range: nil)
}

typealias SyncView = IntegrationView

struct IntegrationSyncRequest: Codable, Hashable, Sendable {
    var date: String
    var timeZone: String

    init(date: String = WorkspaceFormat.dayKey(), timeZone: String = TimeZone.current.identifier) {
        self.date = date
        self.timeZone = timeZone
    }
}

enum IntegrationAction: String, Codable, CaseIterable, Hashable, Sendable {
    case create
    case update
    case delete
    case complete
}

struct IntegrationLinkRequest: Codable, Hashable, Sendable {
    var entityKind: IntegrationEntityKind
    var entityId: String
    var role: IntegrationLinkRole
}

struct IntegrationMutation: Codable, Hashable, Sendable {
    var provider: IntegrationProvider
    var action: IntegrationAction
    var id: String?
    var version: String?
    var requestId: String
    var sourceId: String?
    var anchorDate: String?
    var title: String?
    var date: String?
    var endDate: String?
    var time: String?
    var endTime: String?
    var allDay: Bool?
    var location: String?
    var link: IntegrationLinkRequest?
    var timeZone: String
    // Transport-only intent. It is deliberately excluded from CodingKeys so the
    // strict server schema sees either `date`, `date: null`, or no key at all.
    var encodesNilDate = false

    enum CodingKeys: String, CodingKey {
        case provider, action, id, version, requestId, sourceId, anchorDate, title, date, endDate
        case time, endTime, allDay, location, link, timeZone
    }

    init(
        provider: IntegrationProvider,
        action: IntegrationAction,
        id: String? = nil,
        version: String? = nil,
        requestId: String = UUID().uuidString.lowercased(),
        sourceId: String? = nil,
        anchorDate: String? = nil,
        title: String? = nil,
        date: String? = nil,
        endDate: String? = nil,
        time: String? = nil,
        endTime: String? = nil,
        allDay: Bool? = nil,
        location: String? = nil,
        link: IntegrationLinkRequest? = nil,
        timeZone: String = TimeZone.current.identifier
    ) {
        self.provider = provider
        self.action = action
        self.id = id
        self.version = version
        self.requestId = requestId
        self.sourceId = sourceId
        self.anchorDate = anchorDate
        self.title = title
        self.date = date
        self.endDate = endDate
        self.time = time
        self.endTime = endTime
        self.allDay = allDay
        self.location = location
        self.link = link
        self.timeZone = timeZone
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(provider, forKey: .provider)
        try values.encode(action, forKey: .action)
        try values.encodeIfPresent(id, forKey: .id)
        try values.encodeIfPresent(version, forKey: .version)
        try values.encode(requestId, forKey: .requestId)
        try values.encodeIfPresent(sourceId, forKey: .sourceId)
        try values.encodeIfPresent(anchorDate, forKey: .anchorDate)
        try values.encodeIfPresent(title, forKey: .title)
        if encodesNilDate {
            // The Todoist contract distinguishes an omitted date (leave it unchanged)
            // from JSON null (remove the due date).
            try values.encodeNullable(date, forKey: .date)
        } else {
            try values.encodeIfPresent(date, forKey: .date)
        }
        try values.encodeIfPresent(endDate, forKey: .endDate)
        try values.encodeIfPresent(time, forKey: .time)
        try values.encodeIfPresent(endTime, forKey: .endTime)
        try values.encodeIfPresent(allDay, forKey: .allDay)
        try values.encodeIfPresent(location, forKey: .location)
        try values.encodeIfPresent(link, forKey: .link)
        try values.encode(timeZone, forKey: .timeZone)
    }
}

struct IntegrationUnlinkRequest: Codable, Hashable, Sendable {
    var id: String
}
