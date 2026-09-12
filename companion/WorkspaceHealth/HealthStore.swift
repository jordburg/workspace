import Foundation
import HealthKit

struct HealthDay: Encodable {
    let date: String
    let steps: Double?
    let sleepMinutes: Double?
    let restingHeartRate: Double?
    let weightKg: Double?
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(date, forKey: .date)
        try values.encode(steps, forKey: .steps)
        try values.encode(sleepMinutes, forKey: .sleepMinutes)
        try values.encode(restingHeartRate, forKey: .restingHeartRate)
        try values.encode(weightKg, forKey: .weightKg)
    }
    enum CodingKeys: String, CodingKey { case date, steps, sleepMinutes, restingHeartRate, weightKg }
}
struct WorkoutSummary: Encodable {
    let id: UUID; let name: String; let start: Date; let end: Date; let minutes: Double
    let activity: String; let sourceId: String; let sourceName: String; let timeZone: String?
}
struct HealthSnapshot: Encodable { let version = 1; let id = UUID(); let generatedAt = Date(); let timeZone: String; let from: String; let to: String; let days: [HealthDay]; let workouts: [WorkoutSummary] }
struct SleepRecord: Encodable {
    let id: UUID; let start: Date; let end: Date; let stage: String
    let sourceId: String; let sourceName: String; let timeZone: String?; let sourceVersion: String?
}
struct SleepContextDay: Encodable {
    let date: String; let steps: Double?; let restingHeartRate: Double?; let hrv: Double?
    let activeEnergy: Double?; let exerciseMinutes: Double?; let respiratoryRate: Double?; let oxygenSaturation: Double?
    enum CodingKeys: String, CodingKey { case date, steps, restingHeartRate, hrv, activeEnergy, exerciseMinutes, respiratoryRate, oxygenSaturation }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(date, forKey: .date); try c.encode(steps, forKey: .steps); try c.encode(restingHeartRate, forKey: .restingHeartRate)
        try c.encode(hrv, forKey: .hrv); try c.encode(activeEnergy, forKey: .activeEnergy); try c.encode(exerciseMinutes, forKey: .exerciseMinutes)
        try c.encode(respiratoryRate, forKey: .respiratoryRate); try c.encode(oxygenSaturation, forKey: .oxygenSaturation)
    }
}
struct SleepBatch: Encodable {
    let version = 1; let generatedAt = Date(); let timeZone: String; let from: Date; let to: Date
    let samples: [SleepRecord]; let days: [SleepContextDay]
}

final class HealthStore: @unchecked Sendable {
    let store = HKHealthStore()
    let steps = HKQuantityType(.stepCount)
    let sleep = HKCategoryType(.sleepAnalysis)
    let heart = HKQuantityType(.restingHeartRate)
    let weight = HKQuantityType(.bodyMass)
    private(set) var calendar = Calendar(identifier: .gregorian)
    func refreshCalendar() { var next = Calendar(identifier: .gregorian); next.timeZone = .current; calendar = next }
    func authorize() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw BridgeError.message("Health data is available on a supported iPhone.") }
        try await store.requestAuthorization(toShare: [weight], read: [steps, sleep, heart, weight, HKWorkoutType.workoutType(), HKQuantityType(.heartRateVariabilitySDNN), HKQuantityType(.activeEnergyBurned), HKQuantityType(.appleExerciseTime), HKQuantityType(.respiratoryRate), HKQuantityType(.oxygenSaturation)])
    }
    private func key(_ date: Date) -> String { let format = DateFormatter(); format.calendar = calendar; format.locale = Locale(identifier: "en_US_POSIX"); format.timeZone = calendar.timeZone; format.dateFormat = "yyyy-MM-dd"; return format.string(from: date) }
    private func samples(_ type: HKSampleType, from: Date, to: Date, predicate: NSPredicate? = nil) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate ?? HKQuery.predicateForSamples(withStart: from, end: to), limit: HKObjectQueryNoLimit, sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]) { _, samples, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: samples ?? []) }
            }
            store.execute(query)
        }
    }
    private func dailySteps(from: Date, to: Date) async throws -> [String: Double] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(quantityType: steps, quantitySamplePredicate: HKQuery.predicateForSamples(withStart: from, end: to), options: .cumulativeSum, anchorDate: from, intervalComponents: DateComponents(day: 1))
            query.initialResultsHandler = { [self] _, collection, error in
                if let error { continuation.resume(throwing: error); return }
                var result: [String: Double] = [:]
                collection?.enumerateStatistics(from: from, to: to.addingTimeInterval(-1)) { statistics, _ in
                    if let sum = statistics.sumQuantity() { result[self.key(statistics.startDate)] = sum.doubleValue(for: .count()) }
                }
                continuation.resume(returning: result)
            }
            store.execute(query)
        }
    }
    private func sleepMinutes(_ samples: [HKSample], from: Date, to: Date) -> Double? {
        let asleep = Set([HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue, HKCategoryValueSleepAnalysis.asleepCore.rawValue, HKCategoryValueSleepAnalysis.asleepDeep.rawValue, HKCategoryValueSleepAnalysis.asleepREM.rawValue])
        let intervals = samples.compactMap { $0 as? HKCategorySample }.filter { asleep.contains($0.value) && $0.startDate < to && $0.endDate > from }.map { (max($0.startDate, from), min($0.endDate, to)) }.sorted { $0.0 < $1.0 }
        guard var current = intervals.first else { return nil }
        var seconds: TimeInterval = 0
        for interval in intervals.dropFirst() { if interval.0 <= current.1 { current.1 = max(current.1, interval.1) } else { seconds += current.1.timeIntervalSince(current.0); current = interval } }
        seconds += current.1.timeIntervalSince(current.0)
        return seconds / 60
    }
    func snapshot() async throws -> HealthSnapshot {
        let today = calendar.startOfDay(for: Date())
        let from = calendar.date(byAdding: .day, value: -29, to: today)!
        let end = calendar.date(byAdding: .day, value: 1, to: today)!
        let stepsByDay = try await dailySteps(from: from, to: end)
        let sleepSamples = try await samples(sleep, from: from, to: end)
        let heartSamples = try await samples(heart, from: from, to: end)
        let weightSamples = try await samples(weight, from: from, to: end)
        let workoutSamples = try await samples(HKWorkoutType.workoutType(), from: from, to: end)
        func latest(_ values: [HKSample], day: Date, next: Date, unit: HKUnit) -> Double? { (values.last { $0.endDate >= day && $0.endDate < next } as? HKQuantitySample)?.quantity.doubleValue(for: unit) }
        let days = (0..<30).map { offset in
            let day = calendar.date(byAdding: .day, value: offset, to: from)!
            let next = calendar.date(byAdding: .day, value: 1, to: day)!
            return HealthDay(date: key(day), steps: stepsByDay[key(day)], sleepMinutes: sleepMinutes(sleepSamples, from: day, to: next), restingHeartRate: latest(heartSamples, day: day, next: next, unit: HKUnit.count().unitDivided(by: .minute())), weightKg: latest(weightSamples, day: day, next: next, unit: .gramUnit(with: .kilo)))
        }
        let workouts = workoutSamples.compactMap { value -> WorkoutSummary? in
            guard let workout = value as? HKWorkout else { return nil }
            let source = workout.sourceRevision, product = source.productType ?? workout.device?.model ?? ""
            let metadataZone = workout.metadata?[HKMetadataKeyTimeZone] as? String
            return WorkoutSummary(id: workout.uuid, name: workoutName(workout.workoutActivityType), start: workout.startDate, end: workout.endDate, minutes: workout.duration / 60,
                activity: workoutActivity(workout.workoutActivityType),
                sourceId: source.source.bundleIdentifier + (product.isEmpty ? "" : "|" + product),
                sourceName: source.source.name + (product.isEmpty ? "" : " · " + product),
                timeZone: metadataZone.flatMap { TimeZone(identifier: $0) == nil ? nil : $0 })
        }
        return HealthSnapshot(timeZone: calendar.timeZone.identifier, from: key(from), to: key(today), days: days, workouts: workouts)
    }
    private func dailyQuantity(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, cumulative: Bool = false, from: Date, to: Date) async throws -> [String: Double] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(quantityType: HKQuantityType(identifier), quantitySamplePredicate: HKQuery.predicateForSamples(withStart: from, end: to), options: cumulative ? .cumulativeSum : .discreteAverage, anchorDate: from, intervalComponents: DateComponents(day: 1))
            query.initialResultsHandler = { [self] _, collection, error in
                if let error { continuation.resume(throwing: error); return }
                var result: [String: Double] = [:]
                collection?.enumerateStatistics(from: from, to: to.addingTimeInterval(-1)) { statistics, _ in
                    if let quantity = cumulative ? statistics.sumQuantity() : statistics.averageQuantity() { result[self.key(statistics.startDate)] = quantity.doubleValue(for: unit) }
                }
                continuation.resume(returning: result)
            }
            store.execute(query)
        }
    }
    func sleepBatch(from: Date, to: Date) async throws -> SleepBatch {
        async let raw = samples(sleep, from: from, to: to)
        async let stepValues = dailySteps(from: from, to: to)
        async let heartValues = dailyQuantity(.restingHeartRate, unit: .count().unitDivided(by: .minute()), from: from, to: to)
        async let hrvValues = dailyQuantity(.heartRateVariabilitySDNN, unit: .secondUnit(with: .milli), from: from, to: to)
        async let energyValues = dailyQuantity(.activeEnergyBurned, unit: .kilocalorie(), cumulative: true, from: from, to: to)
        async let exerciseValues = dailyQuantity(.appleExerciseTime, unit: .minute(), cumulative: true, from: from, to: to)
        async let respiratoryValues = dailyQuantity(.respiratoryRate, unit: .count().unitDivided(by: .minute()), from: from, to: to)
        async let oxygenValues = dailyQuantity(.oxygenSaturation, unit: .percent(), from: from, to: to)
        let (sleepSamples, steps, heart, hrv, energy, exercise, respiration, oxygen) = try await (raw, stepValues, heartValues, hrvValues, energyValues, exerciseValues, respiratoryValues, oxygenValues)
        let stages = [0: "inBed", 1: "asleep", 2: "awake", 3: "core", 4: "deep", 5: "rem"]
        let records = sleepSamples.compactMap { value -> SleepRecord? in
            guard let sample = value as? HKCategorySample, let stage = stages[sample.value], sample.endDate > sample.startDate else { return nil }
            let source = sample.sourceRevision, product = source.productType ?? sample.device?.model ?? ""
            let metadataZone = sample.metadata?[HKMetadataKeyTimeZone] as? String
            return SleepRecord(id: sample.uuid, start: sample.startDate, end: sample.endDate, stage: stage,
                sourceId: source.source.bundleIdentifier + "|" + product,
                sourceName: source.source.name + (product.isEmpty ? "" : " · " + product),
                timeZone: metadataZone.flatMap { TimeZone(identifier: $0) == nil ? nil : $0 }, sourceVersion: source.version)
        }
        guard records.count <= 30000 else { throw BridgeError.message("This sleep range has too many records. Import a shorter range.") }
        var days: [SleepContextDay] = [], day = from
        while day < to {
            let date = key(day)
            days.append(SleepContextDay(date: date, steps: steps[date], restingHeartRate: heart[date], hrv: hrv[date], activeEnergy: energy[date], exerciseMinutes: exercise[date], respiratoryRate: respiration[date], oxygenSaturation: oxygen[date].map { $0 * 100 }))
            day = calendar.date(byAdding: .day, value: 1, to: day)!
        }
        return SleepBatch(timeZone: calendar.timeZone.identifier, from: from, to: to, samples: records, days: days)
    }
    private func workoutName(_ type: HKWorkoutActivityType) -> String { switch type { case .climbing: return "Climbing"; case .walking: return "Walking"; case .running: return "Running"; case .cycling: return "Cycling"; case .swimming: return "Swimming"; case .hiking: return "Hiking"; case .yoga: return "Yoga"; case .traditionalStrengthTraining, .functionalStrengthTraining: return "Strength training"; case .highIntensityIntervalTraining: return "HIIT"; default: return "Workout" } }
    private func workoutActivity(_ type: HKWorkoutActivityType) -> String { switch type { case .climbing: return "climbing"; case .walking: return "walking"; case .running: return "running"; case .cycling: return "cycling"; case .swimming: return "swimming"; case .hiking: return "hiking"; case .yoga: return "yoga"; case .traditionalStrengthTraining: return "traditional-strength-training"; case .functionalStrengthTraining: return "functional-strength-training"; case .highIntensityIntervalTraining: return "hiit"; default: return "other" } }
    private func existing(_ command: WeightCommand) async throws -> Bool {
        let identifier = "workspace:" + command.id
        let predicate = HKQuery.predicateForObjects(withMetadataKey: HKMetadataKeySyncIdentifier, allowedValues: [identifier])
        let found = try await samples(weight, from: .distantPast, to: .distantFuture, predicate: predicate)
        guard let sample = found.first(where: { $0.sourceRevision.source.bundleIdentifier == Bundle.main.bundleIdentifier }) else { return false }
        guard sample.metadata?["workspacePayloadHash"] as? String == command.payloadHash else { throw BridgeError.message("An existing Health entry has different values for this request.") }
        return true
    }
    func saveWeight(_ command: WeightCommand) async throws {
        guard command.kg >= 1, command.kg <= 700, command.measuredAt <= Date().addingTimeInterval(300), UUID(uuidString: command.id) != nil else { throw BridgeError.message("Check the measurement and time before saving.") }
        guard store.authorizationStatus(for: weight) == .sharingAuthorized else { throw BridgeError.message("Allow this app to write body mass in Health permissions first.") }
        if try await existing(command) { return }
        let sample = HKQuantitySample(type: weight, quantity: HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: command.kg), start: command.measuredAt, end: command.measuredAt, metadata: [HKMetadataKeySyncIdentifier: "workspace:" + command.id, HKMetadataKeySyncVersion: 1, HKMetadataKeyWasUserEntered: true, "workspacePayloadHash": command.payloadHash])
        do { try await store.save(sample) }
        catch { if try await existing(command) { return }; throw error }
    }
}
