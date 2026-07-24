import SwiftUI
import Foundation
import AVFoundation
import Speech
import Combine
#if os(iOS)
import UIKit
import PhotosUI
import Photos
import WebKit
import UserNotifications
import StoreKit
#endif

private enum AppScreen {
    case splash
    case onboarding
    case avatars
    case permissions
    case review
    case lobby
    case editProfile
    case settings
    case allListeners
    case moodCheckIn
    case sessionSettings
    case live
    case coinStore
    case checkout
    case terms
    case privacy
}

private struct UserProfile: Codable, Equatable {
    var name = ""
    var age = ""
    var pronoun = ""
    var mood = ""
    var avatars: [String] = []
    var userAvatarData: Data?

    var isComplete: Bool {
        !name.isEmpty && !age.isEmpty && !pronoun.isEmpty && !mood.isEmpty && !avatars.isEmpty
    }
}

private struct AppPreferences: Codable, Equatable {
    var privateMode = true
    var supportivePrompts = true
    var softAnimations = true
    var commentsEnabled = true
    var heartsEnabled = true
    var autoPaywall = true
    var isPremiumMember = false
    var sessionLength = 20.0
    var lastMood = "Overwhelmed"
    var lastMoodIntensity = 5.0
    var coins = 100
    var lobbyJoinCount = 500
    var lobbyArriveTime = 1.0
    var selectedViewerPackLabel: String?
    var selectedVibes = ["Fan", "Supporter"]
    var activeCommentCategories = ["general", "agree", "disagree", "compliment"]
    var savedVideos: [SavedLiveVideo] = []
    var rewardSubmissions: [RewardSubmission] = []
    var completedLiveSessions = 0
    var reviewPositiveMoments = 0
    var reviewPromptCount = 0
    var lastReviewPromptAt: Date?
    var didTapOnboardingReview = false

    init() {}

    enum CodingKeys: String, CodingKey {
        case privateMode
        case supportivePrompts
        case softAnimations
        case commentsEnabled
        case heartsEnabled
        case autoPaywall
        case isPremiumMember
        case sessionLength
        case lastMood
        case lastMoodIntensity
        case coins
        case lobbyJoinCount
        case lobbyArriveTime
        case selectedViewerPackLabel
        case selectedVibes
        case activeCommentCategories
        case savedVideos
        case rewardSubmissions
        case completedLiveSessions
        case reviewPositiveMoments
        case reviewPromptCount
        case lastReviewPromptAt
        case didTapOnboardingReview
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        privateMode = try container.decodeIfPresent(Bool.self, forKey: .privateMode) ?? true
        supportivePrompts = try container.decodeIfPresent(Bool.self, forKey: .supportivePrompts) ?? true
        softAnimations = try container.decodeIfPresent(Bool.self, forKey: .softAnimations) ?? true
        commentsEnabled = try container.decodeIfPresent(Bool.self, forKey: .commentsEnabled) ?? true
        heartsEnabled = try container.decodeIfPresent(Bool.self, forKey: .heartsEnabled) ?? true
        autoPaywall = try container.decodeIfPresent(Bool.self, forKey: .autoPaywall) ?? true
        isPremiumMember = try container.decodeIfPresent(Bool.self, forKey: .isPremiumMember) ?? false
        sessionLength = try container.decodeIfPresent(Double.self, forKey: .sessionLength) ?? 20.0
        lastMood = try container.decodeIfPresent(String.self, forKey: .lastMood) ?? "Overwhelmed"
        lastMoodIntensity = try container.decodeIfPresent(Double.self, forKey: .lastMoodIntensity) ?? 5.0
        coins = try container.decodeIfPresent(Int.self, forKey: .coins) ?? 100
        lobbyJoinCount = try container.decodeIfPresent(Int.self, forKey: .lobbyJoinCount) ?? 500
        lobbyArriveTime = try container.decodeIfPresent(Double.self, forKey: .lobbyArriveTime) ?? 1.0
        selectedViewerPackLabel = try container.decodeIfPresent(String.self, forKey: .selectedViewerPackLabel)
        selectedVibes = try container.decodeIfPresent([String].self, forKey: .selectedVibes) ?? ["Fan", "Supporter"]
        activeCommentCategories = try container.decodeIfPresent([String].self, forKey: .activeCommentCategories) ?? ["general", "agree", "disagree", "compliment"]
        savedVideos = try container.decodeIfPresent([SavedLiveVideo].self, forKey: .savedVideos) ?? []
        rewardSubmissions = try container.decodeIfPresent([RewardSubmission].self, forKey: .rewardSubmissions) ?? []
        completedLiveSessions = try container.decodeIfPresent(Int.self, forKey: .completedLiveSessions) ?? 0
        reviewPositiveMoments = try container.decodeIfPresent(Int.self, forKey: .reviewPositiveMoments) ?? 0
        reviewPromptCount = try container.decodeIfPresent(Int.self, forKey: .reviewPromptCount) ?? 0
        lastReviewPromptAt = try container.decodeIfPresent(Date.self, forKey: .lastReviewPromptAt)
        didTapOnboardingReview = try container.decodeIfPresent(Bool.self, forKey: .didTapOnboardingReview) ?? false
    }
}

private struct SavedLiveVideo: Codable, Equatable, Identifiable {
    var id = UUID()
    var createdAt = Date()
    var durationSeconds: Int
    var peakPopularity: Int
    var watermark = "SquadLive"
    var downloadedAt: Date?
}

private struct RewardSubmission: Codable, Equatable, Identifiable {
    var id = UUID()
    var videoID: UUID
    var platform: String
    var proofLink: String
    var screenshotData: Data?
    var status = "Pending review"
    var estimatedRewardCoins: Int
    var submittedAt = Date()
}

private enum PersistenceStore {
    private static let profileKey = "squadlive.profile"
    private static let preferencesKey = "squadlive.preferences"

    static func loadProfile() -> UserProfile {
        load(UserProfile.self, key: profileKey) ?? UserProfile()
    }

    static func saveProfile(_ profile: UserProfile) {
        save(profile, key: profileKey)
    }

    static func loadPreferences() -> AppPreferences {
        load(AppPreferences.self, key: preferencesKey) ?? AppPreferences()
    }

    static func savePreferences(_ preferences: AppPreferences) {
        save(preferences, key: preferencesKey)
    }

    private static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private static func save<T: Encodable>(_ value: T, key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

private struct Listener: Identifiable, Equatable {
    let id: String
    let name: String
    let avatar: String
    let imageURL: String
    let role: String
    let description: String
}

private enum ChatCommentKind {
    case barrage
    case deepAnswer
}

private struct ChatComment: Identifiable {
    let id = UUID()
    let name: String
    let avatar: String
    let text: String
    var kind: ChatCommentKind = .barrage
}

private struct FloatingHeart: Identifiable {
    let id = UUID()
    let emoji: String
    let xOffset: CGFloat
}

private enum ReviewMoment {
    case onboardingTap
    case liveCompleted(duration: Int)
    case shareSubmitted
    case coinPurchased
    case subscribed
}

private enum AppReviewStrategy {
    private static let cooldownDays: TimeInterval = 14 * 24 * 60 * 60
    private static let maxPromptCount = 3

    static func register(_ moment: ReviewMoment, preferences: inout AppPreferences) {
        switch moment {
        case .onboardingTap:
            preferences.didTapOnboardingReview = true
            requestIfAllowed(preferences: &preferences, force: true)
        case .liveCompleted(let duration):
            preferences.completedLiveSessions += 1
            preferences.reviewPositiveMoments += duration >= 12 ? 2 : 1
            requestIfAllowed(preferences: &preferences)
        case .shareSubmitted:
            preferences.reviewPositiveMoments += 2
            requestIfAllowed(preferences: &preferences)
        case .coinPurchased:
            preferences.reviewPositiveMoments += 1
            requestIfAllowed(preferences: &preferences)
        case .subscribed:
            preferences.reviewPositiveMoments += 3
            requestIfAllowed(preferences: &preferences)
        }
    }

    private static func requestIfAllowed(preferences: inout AppPreferences, force: Bool = false) {
        guard preferences.reviewPromptCount < maxPromptCount else { return }

        if let lastPrompt = preferences.lastReviewPromptAt,
           Date().timeIntervalSince(lastPrompt) < cooldownDays {
            return
        }

        if !force {
            guard preferences.completedLiveSessions >= 1 else { return }
            guard preferences.reviewPositiveMoments >= 3 else { return }
        }

        preferences.reviewPromptCount += 1
        preferences.lastReviewPromptAt = Date()
        PersistenceStore.savePreferences(preferences)

#if os(iOS)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            requestSystemReview()
        }
#endif
    }

#if os(iOS)
    private static func requestSystemReview() {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }) else {
            return
        }
        SKStoreReviewController.requestReview(in: scene)
    }
#endif
}

#if os(iOS)
enum PromotionNotificationManager {
    private static let center = UNUserNotificationCenter.current()

    private static let promoCopies: [(String, String)] = [
        ("Tonight feels different", "SquadLive is getting a fresh wave of support right now."),
        ("Your room is filling up", "More viewers are joining the live flow, check what changed."),
        ("A good moment to go live", "Open SquadLive and catch the room while it is active."),
        ("The feed is moving", "New reactions and gifts are showing up in SquadLive."),
        ("Warm support is building", "Your live room looks ready for another round."),
        ("This stream is picking up", "SquadLive is creating a stronger room vibe right now."),
        ("Viewer energy is rising", "Come back and see what your live room looks like now."),
        ("A stronger live pulse", "More people are gathering inside SquadLive."),
        ("The room is active again", "Jump into SquadLive before the moment passes."),
        ("Fresh support just landed", "Your live scene is getting more reactions."),
        ("The live crowd is growing", "SquadLive is showing a busier room today."),
        ("Another round is starting", "Open the app and see the latest live activity."),
        ("Your audience is waking up", "More viewers are appearing in SquadLive."),
        ("Support is stacking up", "The live room feels fuller right now."),
        ("The room has new motion", "SquadLive is bringing in more live reactions."),
        ("A better time to check in", "Your live room may have more activity waiting."),
        ("Things are moving fast", "SquadLive is showing more viewers and gifts."),
        ("The stream feels alive", "Open SquadLive and see the latest crowd growth."),
        ("More people are arriving", "Your live room is getting a little louder."),
        ("A stronger crowd today", "SquadLive is pulling in more live attention."),
        ("The live room is updating", "See the newest viewers and reactions now."),
        ("Support keeps coming in", "Your live session is gaining new momentum."),
        ("The audience is building", "SquadLive is ready with more room activity."),
        ("A fresh live check-in", "Open SquadLive and catch the current flow."),
        ("The room is getting louder", "More reactions are showing up right now."),
        ("Momentum is back", "SquadLive is giving your live room another lift."),
        ("New activity is in", "Your live session is looking more active today."),
        ("The crowd is rolling in", "Open the app and see who is here now."),
        ("The support loop is on", "SquadLive is showing stronger live energy."),
        ("A better live moment", "Your room may have more viewers waiting inside.")
    ]

    static func bootstrap() {
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else {
                requestAuthorization()
                return
            }
            scheduleDailyPromotions()
        }
    }

    private static func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            scheduleDailyPromotions()
        }
    }

    private static func scheduleDailyPromotions() {
        center.removePendingNotificationRequests(withIdentifiers: (0..<30).map { "squadlive.promo.\($0 / 3).\($0 % 3)" })

        let calendar = Calendar.current
        let startDate = Date()
        let slots = [9, 15, 20]

        for dayOffset in 0..<10 {
            for slotIndex in slots.indices {
                let copyIndex = (dayOffset * slots.count + slotIndex) % promoCopies.count
                let (title, body) = promoCopies[copyIndex]
                var components = calendar.dateComponents([.year, .month, .day], from: startDate.addingTimeInterval(TimeInterval(dayOffset * 24 * 60 * 60)))
                components.hour = slots[slotIndex]
                components.minute = slotIndex == 0 ? 30 : (slotIndex == 1 ? 0 : 15)
                guard let targetDate = calendar.date(from: components), targetDate > Date() else { continue }

                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.sound = .default

                let request = UNNotificationRequest(
                    identifier: "squadlive.promo.\(dayOffset).\(slotIndex)",
                    content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
                )
                center.add(request)
            }
        }
    }
}
#endif

private enum GiftAnimationFormat: String, CaseIterable {
    case svga
    case webp
    case png
}

private enum BundleResourceLookup {
    static func urls(forExtension fileExtension: String, subdirectory: String? = nil) -> [URL] {
        let fileManager = FileManager.default
        var results = Bundle.main.urls(forResourcesWithExtension: fileExtension, subdirectory: subdirectory) ?? []

        let directDirectories = [
            subdirectory.flatMap { Bundle.main.resourceURL?.appendingPathComponent($0) },
            Bundle.main.resourceURL,
            Bundle.main.bundleURL
        ].compactMap { $0 }

        for directory in directDirectories where fileManager.fileExists(atPath: directory.path) {
            if let children = try? fileManager.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            ) {
                results.append(contentsOf: children.filter { $0.pathExtension.lowercased() == fileExtension.lowercased() })
            }
        }

        if results.isEmpty,
           let resourceURL = Bundle.main.resourceURL,
           let enumerator = fileManager.enumerator(
            at: resourceURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
           ) {
            for case let url as URL in enumerator where url.pathExtension.lowercased() == fileExtension.lowercased() {
                if let subdirectory {
                    guard url.pathComponents.contains(subdirectory) else { continue }
                }
                results.append(url)
            }
        }

        return Array(Set(results)).sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
    }

    static func url(forResource baseName: String, extension fileExtension: String, subdirectory: String? = nil) -> URL? {
        if let url = Bundle.main.url(forResource: baseName, withExtension: fileExtension, subdirectory: subdirectory) {
            return url
        }
        if let url = Bundle.main.url(forResource: baseName, withExtension: fileExtension) {
            return url
        }

        let fileName = "\(baseName).\(fileExtension)"
        let fileManager = FileManager.default
        let directCandidates = [
            subdirectory.flatMap { Bundle.main.resourceURL?.appendingPathComponent($0).appendingPathComponent(fileName) },
            Bundle.main.resourceURL?.appendingPathComponent(fileName),
            Bundle.main.bundleURL.appendingPathComponent(fileName)
        ].compactMap { $0 }

        if let direct = directCandidates.first(where: { fileManager.fileExists(atPath: $0.path) }) {
            return direct
        }

        guard let resourceURL = Bundle.main.resourceURL,
              let enumerator = fileManager.enumerator(
                at: resourceURL,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
              ) else {
            return nil
        }

        for case let url as URL in enumerator where url.lastPathComponent == fileName {
            return url
        }
        return nil
    }
}

private struct GiftAnimationAsset: Identifiable {
    let id = UUID()
    let baseName: String
    let format: GiftAnimationFormat
    var subdirectory: String?

    var resourceURL: URL? {
        BundleResourceLookup.url(forResource: baseName, extension: format.rawValue, subdirectory: subdirectory)
    }
}

private struct ActiveGiftEffect: Identifiable {
    let id = UUID()
    let asset: GiftAnimationAsset
    let senderName: String
}

private struct AvatarFrameAsset: Identifiable {
    let id = UUID()
    let baseName: String

    var resourceURL: URL? {
        BundleResourceLookup.url(forResource: baseName, extension: "svga", subdirectory: "AvatarFrames")
    }

    var previewURL: URL? {
        BundleResourceLookup.url(forResource: baseName, extension: "png", subdirectory: "AvatarFramePreviews")
    }
}

private enum LiveToolTab: String, CaseIterable {
    case tone = "Tone"
    case vibe = "Vibe"
    case viewers = "Viewers"
    case filters = "Filters"
    case gifts = "Gifts"

    var icon: String {
        switch self {
        case .tone: "bubble.left"
        case .vibe: "sparkles"
        case .viewers: "person.2"
        case .filters: "slider.horizontal.3"
        case .gifts: "gift"
        }
    }
}

private struct DeepSeekChatRequest: Encodable {
    let model: String
    let messages: [DeepSeekMessage]
    let temperature: Double
    let maxTokens: Int

    enum CodingKeys: String, CodingKey {
        case model
        case messages
        case temperature
        case maxTokens = "max_tokens"
    }
}

private struct DeepSeekMessage: Codable {
    let role: String
    let content: String
}

private struct DeepSeekChatResponse: Decodable {
    struct Choice: Decodable {
        let message: DeepSeekMessage
    }

    let choices: [Choice]
}

private struct SquadLiveAIProxyRequest: Encodable {
    let text: String
    let listener: ListenerPayload
    let roleMode: String
    let replyDepth: Double
    let activeDirections: [String]
    let toneTopics: [String]
    let vibeMoods: [String]
    let liveSeconds: Int

    struct ListenerPayload: Encodable {
        let name: String
        let role: String
    }
}

private struct SquadLiveAIProxyResponse: Decodable {
    let answer: String
}

private enum DeepSeekClient {
    static func answer(userText: String, listener: Listener, roleMode: String, replyDepth: Double, activeDirections: [String], toneTopics: [String], vibeMoods: [String], liveSeconds: Int) async -> String? {
        if let backendAnswer = await answerViaBackend(
            userText: userText,
            listener: listener,
            roleMode: roleMode,
            replyDepth: replyDepth,
            activeDirections: activeDirections,
            toneTopics: toneTopics,
            vibeMoods: vibeMoods,
            liveSeconds: liveSeconds
        ) {
            return backendAnswer
        }

        guard let apiKey = Bundle.main.object(forInfoDictionaryKey: "DEEPSEEK_API_KEY") as? String,
              !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let url = URL(string: "https://api.deepseek.com/chat/completions") else {
            return nil
        }

        let directionGuide = Self.directionGuide(activeDirections)
        let toneGuide = toneTopics.isEmpty ? "General" : toneTopics.joined(separator: ", ")
        let vibeGuide = vibeMoods.isEmpty ? "Warm, calm" : vibeMoods.joined(separator: ", ")
        let liveStage = liveSeconds < 60 ? "opening" : (liveSeconds < 300 ? "active" : "late")
        let systemPrompt = """
        You are \(listener.name), a virtual live-room friend inside SquadLive.
        Role mode: \(roleMode).
        Live stage: \(liveStage).
        Tone topics: \(toneGuide).
        Vibe mood: \(vibeGuide).
        Reply directly to the user based on what they just said.
        \(directionGuide)
        Keep it specific and natural.
        When it fits the moment, include one short compliment about the user's voice, appearance, camera presence, smile, or energy.
        Do not repeat the same compliment style twice in a row.
        Avoid generic greetings and avoid sounding scripted.
        Use \(replyDepth > 0.72 ? "2-3 short sentences" : "1-2 short sentences").
        """
        let body = DeepSeekChatRequest(
            model: "deepseek-chat",
            messages: [
                DeepSeekMessage(role: "system", content: systemPrompt),
                DeepSeekMessage(role: "user", content: userText)
            ],
            temperature: min(0.9, max(0.45, 0.52 + replyDepth * 0.32)),
            maxTokens: replyDepth > 0.72 ? 180 : 120
        )

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 16

        do {
            request.httpBody = try JSONEncoder().encode(body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }
            let decoded = try JSONDecoder().decode(DeepSeekChatResponse.self, from: data)
            return decoded.choices.first?.message.content.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private static func answerViaBackend(userText: String, listener: Listener, roleMode: String, replyDepth: Double, activeDirections: [String], toneTopics: [String], vibeMoods: [String], liveSeconds: Int) async -> String? {
        guard let rawBaseURL = Bundle.main.object(forInfoDictionaryKey: "SQUADLIVE_API_BASE_URL") as? String,
              !rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let baseURL = URL(string: rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }

        let requestBody = SquadLiveAIProxyRequest(
            text: userText,
            listener: .init(name: listener.name, role: listener.role),
            roleMode: roleMode,
            replyDepth: replyDepth,
            activeDirections: activeDirections,
            toneTopics: toneTopics,
            vibeMoods: vibeMoods,
            liveSeconds: liveSeconds
        )

        var request = URLRequest(url: baseURL.appendingPathComponent("v1/ai/deepseek"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 16

        do {
            request.httpBody = try JSONEncoder().encode(requestBody)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }
            return try JSONDecoder().decode(SquadLiveAIProxyResponse.self, from: data).answer
        } catch {
            return nil
        }
    }

    private static func directionGuide(_ activeDirections: [String]) -> String {
        let labels = activeDirections.compactMap { direction -> String? in
            switch direction {
            case "general": return "Stay conversational and directly respond to the user's point."
            case "agree": return "Agree when appropriate and keep the energy supportive."
            case "disagree": return "Offer gentle pushback without sounding argumentative."
            case "compliment": return "Offer a warm compliment about the user's voice, look, confidence, or camera presence."
            case "beauty": return "Notice appearance, styling, expression, and camera feel in a flattering but natural way."
            case "fashion": return "Comment on styling, outfit, or visual presentation."
            case "health": return "Keep the tone calming, grounding, and reassuring."
            case "lifestyle": return "React to daily-life updates with familiarity and care."
            case "gifts": return "Acknowledge gifts and appreciation from the room."
            default: return nil
            }
        }
        guard !labels.isEmpty else {
            return "Keep the reply focused on what the user said, and add a brief supportive compliment when it feels natural."
        }
        return labels.joined(separator: " ")
    }
}

private final class SpeechTranscriber: ObservableObject {
    @Published var transcript = ""
    @Published var statusText = "Listening..."

#if os(iOS)
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
#endif

    func start() {
#if os(iOS)
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            statusText = "Speech recognition is not enabled."
            return
        }

        stop()
        transcript = ""
        statusText = "Listening..."

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

            let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
            recognitionRequest.shouldReportPartialResults = true
            request = recognitionRequest

            let inputNode = audioEngine.inputNode
            let recordingFormat = inputNode.outputFormat(forBus: 0)
            inputNode.removeTap(onBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak recognitionRequest] buffer, _ in
                recognitionRequest?.append(buffer)
            }

            audioEngine.prepare()
            try audioEngine.start()

            task = recognizer?.recognitionTask(with: recognitionRequest) { [weak self] result, error in
                DispatchQueue.main.async {
                    if let result {
                        self?.transcript = result.bestTranscription.formattedString
                    }
                    if error != nil || result?.isFinal == true {
                        self?.statusText = error == nil ? "Voice ready." : "Voice paused."
                    }
                }
            }
        } catch {
            statusText = "Microphone is unavailable."
            stop()
        }
#else
        statusText = "Speech recognition runs on iPhone."
#endif
    }

    func stop() {
#if os(iOS)
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
#endif
    }
}

struct ContentView: View {
    @State private var screen: AppScreen
    @State private var profile: UserProfile
    @State private var preferences: AppPreferences
    @State private var initialScreen: AppScreen
    @State private var selectedListener = Self.listeners[0]
    @State private var showPaywall = false
    @State private var showCheckoutOverlay = false
    @State private var showCoinStoreOverlay = false
    @State private var checkoutReturnScreen: AppScreen = .lobby
    @State private var coinStoreReturnScreen: AppScreen = .lobby

    private static let listeners = [
        Listener(id: "1", name: "Sarah", avatar: "👩‍🦰", imageURL: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=420&h=420&q=85", role: "The Empath", description: "Warm, understanding, always validates your feelings"),
        Listener(id: "2", name: "David", avatar: "👨‍💼", imageURL: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=420&h=420&q=85", role: "The Rational Advisor", description: "Thoughtful insights, practical solutions"),
        Listener(id: "3", name: "Maya", avatar: "🧘‍♀️", imageURL: "https://images.unsplash.com/photo-1531123897727-8f129e1688ce?auto=format&fit=crop&w=420&h=420&q=85", role: "The Zen Guide", description: "Calm energy, mindfulness-based support")
    ]

    init() {
        let savedProfile = PersistenceStore.loadProfile()
        _profile = State(initialValue: savedProfile)
        _preferences = State(initialValue: PersistenceStore.loadPreferences())
        _initialScreen = State(initialValue: savedProfile.isComplete ? .lobby : .onboarding)
        _screen = State(initialValue: .splash)
    }

    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()

            switch screen {
            case .splash:
                BrandSplashView {
                    withAnimation(.easeInOut) { screen = initialScreen }
                }
            case .onboarding:
                OnboardingView { name, age, pronoun, mood in
                    profile.name = name
                    profile.age = age
                    profile.pronoun = pronoun
                    profile.mood = mood
                    PersistenceStore.saveProfile(profile)
                    withAnimation(.easeInOut) { screen = .avatars }
                }
            case .avatars:
                AvatarSelectionView(pronoun: profile.pronoun) { avatars in
                    profile.avatars = avatars
                    PersistenceStore.saveProfile(profile)
                    withAnimation(.easeInOut) { screen = .permissions }
                }
            case .permissions:
                PermissionsView(
                    onAllow: { withAnimation(.easeInOut) { screen = .review } },
                    onSkip: { withAnimation(.easeInOut) { screen = .review } }
                )
            case .review:
                ReviewView(
                    onRate: {
                        AppReviewStrategy.register(.onboardingTap, preferences: &preferences)
                        withAnimation(.easeInOut) { screen = .lobby }
                    },
                    onSkip: { withAnimation(.easeInOut) { screen = .lobby } }
                )
            case .lobby:
                LobbyView(
                    userName: profile.name.isEmpty ? "Friend" : profile.name,
                    userAvatarData: profile.userAvatarData,
                    listeners: Self.listeners,
                    selectedListener: $selectedListener,
                    preferences: $preferences,
                    onEditProfile: { withAnimation(.easeInOut) { screen = .editProfile } },
                    onSettings: { withAnimation(.easeInOut) { screen = .settings } },
                    onShowCoinStore: { openCoinStore(from: .lobby) },
                    onShowVIP: { openCheckout(from: .lobby) },
                    onSeeAll: { withAnimation(.easeInOut) { screen = .allListeners } },
                    onMoodCheckIn: { withAnimation(.easeInOut) { screen = .moodCheckIn } },
                    onSessionSettings: { withAnimation(.easeInOut) { screen = .sessionSettings } }
                ) {
                    showPaywall = false
                    withAnimation(.easeInOut) { screen = .live }
                }
            case .editProfile:
                EditProfileView(profile: profile, onBack: {
                    withAnimation(.easeInOut) { screen = .lobby }
                }, onSave: { updatedProfile in
                    profile = updatedProfile
                    PersistenceStore.saveProfile(updatedProfile)
                    withAnimation(.easeInOut) { screen = .lobby }
                })
            case .settings:
                AppSettingsView(preferences: $preferences) {
                    PersistenceStore.savePreferences(preferences)
                    withAnimation(.easeInOut) { screen = .lobby }
                }
            case .allListeners:
                AllListenersView(listeners: Self.listeners, selectedListener: $selectedListener) {
                    withAnimation(.easeInOut) { screen = .lobby }
                }
            case .moodCheckIn:
                MoodCheckInView(preferences: $preferences) {
                    PersistenceStore.savePreferences(preferences)
                    withAnimation(.easeInOut) { screen = .lobby }
                }
            case .sessionSettings:
                SessionSettingsView(preferences: $preferences) {
                    PersistenceStore.savePreferences(preferences)
                    withAnimation(.easeInOut) { screen = .lobby }
                }
            case .live:
                LiveStreamView(
                    listener: selectedListener,
                    preferences: preferences,
                    initialPopularity: Self.liveBasePopularity(for: preferences),
                    purchasedAudienceCount: Self.purchasedAudienceBoost(for: preferences),
                    showPaywall: $showPaywall,
                    onEnd: { duration, peakPopularity in
                        saveFinishedLiveVideo(duration: duration, peakPopularity: peakPopularity)
                        withAnimation(.easeInOut) { screen = .lobby }
                    },
                    onShowCoinStore: { openCoinStore(from: .live) },
                    onUpgrade: { openCheckout(from: .live) }
                )
            case .coinStore:
                CoinStoreView(
                    coins: preferences.coins,
                    onClose: {
                        withAnimation(.easeInOut) { screen = coinStoreReturnScreen }
                    },
                    onBuy: { amount in
                        preferences.coins += amount
                        AppReviewStrategy.register(.coinPurchased, preferences: &preferences)
                        PersistenceStore.savePreferences(preferences)
                    }
                )
            case .checkout:
                PremiumCheckoutView(
                    onClose: {
                        showPaywall = checkoutReturnScreen == .live
                        withAnimation(.easeInOut) { screen = checkoutReturnScreen }
                    },
                    onSubscribe: {
                        showPaywall = false
                        preferences.isPremiumMember = true
                        AppReviewStrategy.register(.subscribed, preferences: &preferences)
                        PersistenceStore.savePreferences(preferences)
                        withAnimation(.easeInOut) { screen = checkoutReturnScreen }
                    },
                    onTerms: {
                        withAnimation(.easeInOut) { screen = .terms }
                    },
                    onPrivacy: {
                        withAnimation(.easeInOut) { screen = .privacy }
                    }
                )
            case .terms:
                LegalTextView(kind: .terms) {
                    withAnimation(.easeInOut) { screen = .checkout }
                }
            case .privacy:
                LegalTextView(kind: .privacy) {
                    withAnimation(.easeInOut) { screen = .checkout }
                }
            }

            if showCheckoutOverlay {
                PremiumCheckoutView(
                    onClose: {
                        showPaywall = false
                        withAnimation(.easeInOut) { showCheckoutOverlay = false }
                    },
                    onSubscribe: {
                        showPaywall = false
                        preferences.isPremiumMember = true
                        AppReviewStrategy.register(.subscribed, preferences: &preferences)
                        PersistenceStore.savePreferences(preferences)
                        withAnimation(.easeInOut) { showCheckoutOverlay = false }
                    },
                    onTerms: {},
                    onPrivacy: {}
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .zIndex(10)
            }

            if showCoinStoreOverlay {
                CoinStoreView(
                    coins: preferences.coins,
                    onClose: {
                        withAnimation(.easeInOut) { showCoinStoreOverlay = false }
                    },
                    onBuy: { amount in
                        preferences.coins += amount
                        AppReviewStrategy.register(.coinPurchased, preferences: &preferences)
                        PersistenceStore.savePreferences(preferences)
                    }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .zIndex(11)
            }
        }
        .preferredColorScheme(.dark)
        .onChange(of: profile) { _, newValue in
            PersistenceStore.saveProfile(newValue)
        }
        .onChange(of: preferences) { _, newValue in
            PersistenceStore.savePreferences(newValue)
        }
    }

    private func saveFinishedLiveVideo(duration: Int, peakPopularity: Int) {
        let video = SavedLiveVideo(durationSeconds: max(duration, 1), peakPopularity: peakPopularity)
        preferences.savedVideos.insert(video, at: 0)
        preferences.savedVideos = Array(preferences.savedVideos.prefix(20))
        AppReviewStrategy.register(.liveCompleted(duration: duration), preferences: &preferences)
        PersistenceStore.savePreferences(preferences)
    }

    private static func liveBasePopularity(for preferences: AppPreferences) -> Int {
        if preferences.isPremiumMember {
            return Int.random(in: 20_000...28_000)
        }
        return Int.random(in: 450...650)
    }

    private static func purchasedAudienceBoost(for preferences: AppPreferences) -> Int {
        max(0, preferences.lobbyJoinCount - 500)
    }

    private func openCheckout(from returnScreen: AppScreen) {
        checkoutReturnScreen = returnScreen
        if returnScreen == .live {
            withAnimation(.easeInOut) {
                showCheckoutOverlay = true
            }
        } else {
            withAnimation(.easeInOut) {
                screen = .checkout
            }
        }
    }

    private func openCoinStore(from returnScreen: AppScreen) {
        coinStoreReturnScreen = returnScreen
        if returnScreen == .live {
            withAnimation(.easeInOut) {
                showCoinStoreOverlay = true
            }
        } else {
            withAnimation(.easeInOut) {
                screen = .coinStore
            }
        }
    }
}

private struct BrandSplashView: View {
    let onComplete: () -> Void
    @State private var isVisible = false

    var body: some View {
        VStack(spacing: 22) {
            Image("SquadLiveBrand")
                .resizable()
                .scaledToFit()
                .frame(width: 132, height: 132)
                .clipShape(RoundedRectangle(cornerRadius: 32))
                .shadow(color: .hotPink.opacity(0.24), radius: 22)
            .scaleEffect(isVisible ? 1 : 0.92)
            .opacity(isVisible ? 1 : 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.appBackground)
        .onAppear {
            withAnimation(.easeOut(duration: 0.45)) {
                isVisible = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.95) {
                onComplete()
            }
        }
    }
}

private struct OnboardingView: View {
    let onComplete: (String, String, String, String) -> Void

    @State private var step = 0
    @State private var name = ""
    @State private var age = ""
    @State private var pronoun = ""
    @State private var mood = ""

    private let names = ["Luna", "Phoenix", "River", "Sky", "Sage", "Atlas", "Nova", "Echo", "Blaze", "Storm", "Ash", "Ember"]

    private var progress: CGFloat { CGFloat(step + 1) / 4.0 }
    private var isComplete: Bool {
        switch step {
        case 0: !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case 1: !age.isEmpty
        case 2: !pronoun.isEmpty
        default: !mood.isEmpty
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                if step > 0 {
                    Button {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { step -= 1 }
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background(.white.opacity(0.10), in: Circle())
                    }
                }

                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.white.opacity(0.10))
                        Capsule()
                            .fill(Color.brandPurple)
                            .frame(width: proxy.size.width * progress)
                    }
                }
                .frame(height: 4)
            }
            .padding(.horizontal, 24)
            .padding(.top, 22)

            Spacer()

            VStack(spacing: 36) {
                Text(questionTitle)
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)

                if step == 0 {
                    VStack(spacing: 16) {
                        TextField("Name", text: $name)
                            .multilineTextAlignment(.center)
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 20)
                            .frame(height: 58)
                            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
                            .overlay(
                                RoundedRectangle(cornerRadius: 18)
                                    .stroke(.white.opacity(0.22), lineWidth: 2)
                            )

                        Button {
                            name = names.randomElement() ?? "Luna"
                        } label: {
                            Label("Generate Random", systemImage: "sparkles")
                                .foregroundStyle(.white.opacity(0.72))
                        }
                    }
                } else {
                    VStack(spacing: 14) {
                        ForEach(options, id: \.value) { option in
                            Button {
                                select(option.value)
                            } label: {
                                Text(option.label)
                                    .font(.system(size: 17, weight: .semibold))
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 58)
                                    .foregroundStyle(selectedValue == option.value ? .white : .white.opacity(0.72))
                                    .background(selectedValue == option.value ? Color.brandPurple : .white.opacity(0.06), in: Capsule())
                                    .overlay(
                                        Capsule()
                                            .stroke(selectedValue == option.value ? Color.brandPurple : .white.opacity(0.22), lineWidth: 2)
                                    )
                                    .shadow(color: selectedValue == option.value ? .brandPurple.opacity(0.35) : .clear, radius: 18)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 24)

            Spacer()

            VStack(spacing: 18) {
                Button {
                    if step < 3 {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { step += 1 }
                    } else {
                        onComplete(name, age, pronoun, mood)
                    }
                } label: {
                    HStack(spacing: 8) {
                        Text(step < 3 ? "Continue" : "Let's Begin")
                        Image(systemName: "chevron.right")
                    }
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(isComplete ? .white : .white.opacity(0.42))
                    .frame(maxWidth: .infinity)
                    .frame(height: 58)
                    .background(isComplete ? Color.brandPurple : .white.opacity(0.10), in: Capsule())
                    .shadow(color: isComplete ? .brandPurple.opacity(0.35) : .clear, radius: 22)
                }
                .disabled(!isComplete)

                Text("🔒 100% Private AI experience. No real humans.")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.42))
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 30)
        }
    }

    private var questionTitle: String {
        switch step {
        case 0: "What should your AI friends call you?"
        case 1: "Your fans ask: how old is the star?"
        case 2: "How should your AI friends address you?"
        default: "What's on your mind today?"
        }
    }

    private var selectedValue: String {
        switch step {
        case 1: age
        case 2: pronoun
        default: mood
        }
    }

    private var options: [(label: String, value: String)] {
        switch step {
        case 1:
            [("Under 18", "under18"), ("18-24", "18-24"), ("25-34", "25-34"), ("35-44", "35-44"), ("45+", "45+")]
        case 2:
            [("He/Him", "he"), ("She/Her", "she"), ("They/Them", "they")]
        default:
            [("Venting work stress", "work"), ("Relationship advice", "relationship"), ("Just feeling lonely", "lonely"), ("Need a hype squad", "hype")]
        }
    }

    private func select(_ value: String) {
        switch step {
        case 1: age = value
        case 2: pronoun = value
        default: mood = value
        }
    }
}

private struct AvatarSelectionView: View {
    let pronoun: String
    let onComplete: ([String]) -> Void
    @State private var selected: [AIFriend] = []

    private let friends = [
        AIFriend(name: "Sophia", role: "Hype Queen", emoji: "🔥", imageURL: "https://randomuser.me/api/portraits/women/44.jpg"),
        AIFriend(name: "Madison", role: "Sweet Support", emoji: "💕", imageURL: "https://randomuser.me/api/portraits/women/68.jpg"),
        AIFriend(name: "Riley", role: "The Comedian", emoji: "😂", imageURL: "https://randomuser.me/api/portraits/women/12.jpg"),
        AIFriend(name: "Ava", role: "Deep Thinker", emoji: "🤔", imageURL: "https://randomuser.me/api/portraits/women/79.jpg"),
        AIFriend(name: "Emma", role: "Gentle Soul", emoji: "🌸", imageURL: "https://randomuser.me/api/portraits/women/32.jpg"),
        AIFriend(name: "Zoe", role: "Loyal Fan", emoji: "👑", imageURL: "https://randomuser.me/api/portraits/women/26.jpg"),
        AIFriend(name: "Mia", role: "Drama Queen", emoji: "🎭", imageURL: "https://randomuser.me/api/portraits/women/89.jpg"),
        AIFriend(name: "Chloe", role: "Cheerleader", emoji: "✨", imageURL: "https://randomuser.me/api/portraits/women/53.jpg"),
        AIFriend(name: "Luna", role: "Night Owl", emoji: "🌙", imageURL: "https://randomuser.me/api/portraits/women/21.jpg"),
        AIFriend(name: "Harper", role: "Soft Voice", emoji: "💫", imageURL: "https://randomuser.me/api/portraits/women/65.jpg"),
        AIFriend(name: "Nora", role: "Calm Coach", emoji: "🫶", imageURL: "https://randomuser.me/api/portraits/women/36.jpg"),
        AIFriend(name: "Ivy", role: "Bright Spark", emoji: "⚡️", imageURL: "https://randomuser.me/api/portraits/women/7.jpg")
    ]

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.appBackground.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("AI FRIENDS", systemImage: "heart.fill")
                            .font(.system(size: 13, weight: .bold))
                            .tracking(1.8)
                            .foregroundStyle(Color.brandPurple)

                        Text("Meet your new AI friends")
                            .font(.system(size: 28, weight: .black))
                            .foregroundStyle(.white)

                        Text("Pick up to 3 — they'll show up in your stream, cheer you on & keep the energy going.")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(.white.opacity(0.58))
                            .lineSpacing(5)
                    }
                    .padding(.top, 32)

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 3), spacing: 16) {
                        ForEach(friends) { friend in
                            let selectedIndex = selected.firstIndex(of: friend)
                            Button {
                                toggle(friend)
                            } label: {
                                AIFriendCard(friend: friend, selectedIndex: selectedIndex)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 30)
                .padding(.bottom, 180)
            }

            AIFriendSelectionBar(selected: selected) {
                onComplete(selected.map(\.imageURL))
            }
        }
    }

    private func toggle(_ friend: AIFriend) {
        if selected.contains(friend) {
            selected.removeAll { $0 == friend }
        } else if selected.count < 3 {
            selected.append(friend)
        }
    }
}

private struct AIFriend: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let role: String
    let emoji: String
    let imageURL: String
}

private struct AIFriendCard: View {
    let friend: AIFriend
    let selectedIndex: Int?

    private var isSelected: Bool {
        selectedIndex != nil
    }

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .topTrailing) {
                VStack(spacing: 0) {
                    RemoteImage(urlString: friend.imageURL)
                        .frame(width: width, height: width * 1.02)
                        .clipped()
                        .overlay(alignment: .bottom) {
                            LinearGradient(colors: [.clear, .black.opacity(0.36)], startPoint: .top, endPoint: .bottom)
                                .frame(height: 40)
                        }

                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(friend.emoji) \(friend.name)")
                            .font(.system(size: 16, weight: .black))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.78)
                        Text(friend.role)
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(isSelected ? Color.brandPurple : .white.opacity(0.38))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: 58)
                    .background(isSelected ? Color.brandPurple.opacity(0.14) : .white.opacity(0.09))
                }
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(isSelected ? Color.brandPurple : .white.opacity(0.12), lineWidth: isSelected ? 2.4 : 1.2)
                )
                .background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 16))

                if let selectedIndex {
                    HStack(spacing: 0) {
                        Text("\(selectedIndex + 1)")
                            .font(.system(size: 13, weight: .black))
                            .foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                            .background(Color.brandPurple, in: Circle())

                        Image(systemName: "checkmark")
                            .font(.system(size: 13, weight: .black))
                            .foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                            .background(Color.brandPurple, in: Circle())
                    }
                    .padding(10)
                }
            }
            .shadow(color: isSelected ? .brandPurple.opacity(0.24) : .clear, radius: 12)
        }
        .aspectRatio(0.67, contentMode: .fit)
    }
}

private struct AIFriendSelectionBar: View {
    let selected: [AIFriend]
    let onStart: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                HStack(spacing: -8) {
                    ForEach(selected) { friend in
                        RemoteImage(urlString: friend.imageURL)
                            .frame(width: 34, height: 34)
                            .clipShape(Circle())
                            .overlay(Circle().stroke(Color.appBackground, lineWidth: 2))
                    }
                }
                .frame(width: 92, alignment: .leading)

                VStack(alignment: .leading, spacing: 3) {
                    Text(selected.isEmpty ? "Choose 3 AI friends" : selected.map(\.name).joined(separator: ", "))
                        .font(.system(size: 16, weight: .black))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(selected.count == 3 ? "will be in your stream 💜" : "Pick exactly 3 to start")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.52))
                }

                Spacer()

                Text("\(selected.count)/3")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Color.brandPurple)
            }

            Button(action: onStart) {
                HStack(spacing: 7) {
                    Text(selected.count == 3 ? "Start with 3 friends" : "Select \(3 - selected.count) more")
                    if selected.count == 3 {
                        Image(systemName: "arrow.right")
                    }
                }
                .font(.system(size: 17, weight: .black))
                .foregroundStyle(selected.count == 3 ? .white : .white.opacity(0.42))
                .frame(maxWidth: .infinity)
                .frame(height: 60)
                .background(selected.count == 3 ? Color.brandPurple : .white.opacity(0.10), in: RoundedRectangle(cornerRadius: 18))
                .shadow(color: selected.count == 3 ? .brandPurple.opacity(0.38) : .clear, radius: 20)
            }
            .disabled(selected.count != 3)
        }
        .padding(.horizontal, 24)
        .padding(.top, 18)
        .padding(.bottom, 20)
        .background(.black.opacity(0.82))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(.white.opacity(0.08))
                .frame(height: 1)
        }
    }
}

private struct UserAvatarView: View {
    let imageData: Data?
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(LinearGradient(colors: [.brandPurple, .brandOrange], startPoint: .topLeading, endPoint: .bottomTrailing))

#if os(iOS)
            if let imageData, let image = UIImage(data: imageData) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "person.fill")
                    .font(.system(size: size * 0.42, weight: .bold))
                    .foregroundStyle(.white.opacity(0.90))
            }
#else
            Image(systemName: "person.fill")
                .font(.system(size: size * 0.42, weight: .bold))
                .foregroundStyle(.white.opacity(0.90))
#endif
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.brandPurple.opacity(0.65), lineWidth: 2))
        .shadow(color: .brandPurple.opacity(0.22), radius: 12)
    }
}

#if os(iOS)
private func compressAvatarImageData(_ data: Data) async -> Data? {
    guard let image = UIImage(data: data) else { return nil }
    let targetSize = CGSize(width: 360, height: 360)
    let renderer = UIGraphicsImageRenderer(size: targetSize)
    let rendered = renderer.image { _ in
        let sourceSize = image.size
        let scale = max(targetSize.width / sourceSize.width, targetSize.height / sourceSize.height)
        let drawSize = CGSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
        let origin = CGPoint(x: (targetSize.width - drawSize.width) / 2, y: (targetSize.height - drawSize.height) / 2)
        image.draw(in: CGRect(origin: origin, size: drawSize))
    }
    return rendered.jpegData(compressionQuality: 0.82)
}
#endif

private struct PermissionsView: View {
    let onAllow: () -> Void
    let onSkip: () -> Void
    @State private var isRequesting = false

    private let permissions = [
        ("camera.fill", "Camera Access", "This lets you visually interact with your AI audience in a fully immersive way. Feel assured, we never record or store your camera feed."),
        ("mic.fill", "Microphone", "By enabling microphone access, you can chat with your AI fans naturally through voice."),
        ("dot.radiowaves.left.and.right", "Voice Understanding", "This helps your AI fans understand what you say and reply naturally during the live session. We do not store your voice.")
    ]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Allow Access")
                            .font(.system(size: 28, weight: .bold))
                            .foregroundStyle(.white)
                        HStack(spacing: 8) {
                            Circle().fill(Color.brandPurple).frame(width: 8, height: 8)
                            Text("Privacy First")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.brandPurple)
                        }
                        Text("SquadLive offers an AI-powered live streaming experience designed as an emotional support tool. Everything happens locally on your device - your privacy is fully respected and protected.")
                            .font(.system(size: 14))
                            .foregroundStyle(.white.opacity(0.62))
                            .lineSpacing(3)
                    }

                    Text("Permissions and Their Purpose")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.white)

                    ForEach(permissions, id: \.1) { item in
                        InfoRow(icon: item.0, title: item.1, description: item.2)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 28)
                .padding(.bottom, 24)
            }

            VStack(spacing: 10) {
                PrimaryButton(title: isRequesting ? "Requesting..." : "Allow") {
                    requestPermissions()
                }
                .disabled(isRequesting)
                Button("Not Now", action: onSkip)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white.opacity(0.62))
                    .frame(height: 48)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 28)
        }
    }

    private func requestPermissions() {
        isRequesting = true

        let group = DispatchGroup()

        group.enter()
        AVCaptureDevice.requestAccess(for: .video) { _ in
            group.leave()
        }

        group.enter()
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            group.leave()
        }

        group.enter()
        SFSpeechRecognizer.requestAuthorization { _ in
            group.leave()
        }

        group.notify(queue: .main) {
            isRequesting = false
            onAllow()
        }
    }
}

private struct ReviewView: View {
    let onRate: () -> Void
    let onSkip: () -> Void

    private let reviews = [
        ("Life-changing support", "I love this app! Even tho it just came out there's no issues with it I love the Ai and like the fact I can just talk and feel heard for the first time!"),
        ("Finally someone who listens", "Omg I can share anything without judgment. This feels so real and I'm not alone anymore"),
        ("The best safe space", "Literally the best. I feels like your actually talking to someone who truly cares"),
        ("Love it!!!!!", "I love it because I never felt this supported before this is my new favorite app ❤️🔥👏")
    ]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 18) {
                    Text("SquadLive\(Text(".").foregroundColor(.brandPurple))")
                        .font(.system(size: 32, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.bottom, 10)

                    ForEach(reviews, id: \.0) { review in
                        VStack(alignment: .leading, spacing: 10) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(review.0)
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(.white)
                                HStack(spacing: 1) {
                                    ForEach(0..<5, id: \.self) { _ in
                                        Image(systemName: "star.fill")
                                            .font(.system(size: 12))
                                            .foregroundStyle(Color.gold)
                                    }
                                }
                            }
                            Text(review.1)
                                .font(.system(size: 14))
                                .foregroundStyle(.white.opacity(0.72))
                                .lineSpacing(3)
                        }
                        .padding(18)
                        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
                        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.10)))
                    }

                    VStack(spacing: 10) {
                        Text("We'd love to hear from you!")
                            .font(.system(size: 25, weight: .bold))
                            .foregroundStyle(.white)
                        Text("Show your love by giving us a review on the App Store.")
                            .font(.system(size: 14))
                            .foregroundStyle(.white.opacity(0.62))
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 10)
                }
                .padding(.horizontal, 24)
                .padding(.top, 28)
                .padding(.bottom, 24)
            }

            VStack(spacing: 10) {
                PrimaryButton(title: "Rate Us", action: onRate)
                Button("Maybe Later", action: onSkip)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white.opacity(0.62))
                    .frame(height: 48)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 28)
        }
    }
}

private struct LobbyView: View {
    let userName: String
    let userAvatarData: Data?
    let listeners: [Listener]
    @Binding var selectedListener: Listener
    @Binding var preferences: AppPreferences
    let onEditProfile: () -> Void
    let onSettings: () -> Void
    let onShowCoinStore: () -> Void
    let onShowVIP: () -> Void
    let onSeeAll: () -> Void
    let onMoodCheckIn: () -> Void
    let onSessionSettings: () -> Void
    let onGoLive: () -> Void

    private enum Tab: String, CaseIterable {
        case basic = "Basic"
        case audience = "Audience"
        case comments = "Comments"
        case saved = "Saved"
    }

    @State private var activeTab: Tab = .basic
    @State private var showCountdown = false
    @State private var showCoinRechargeAlert = false
    @State private var countdown = 3
    @State private var countdownTimer: Timer?
    @State private var rewardVideoID: UUID?
    @State private var rewardPlatform = "TikTok"
    @State private var rewardProofLink = ""
    @State private var rewardScreenshotData: Data?
    @State private var savedVideoMessage: String?
#if os(iOS)
    @State private var selectedRewardScreenshot: PhotosPickerItem?
#endif

    private let vibes = [
        ("Joker", "😂", "Always makes jokes"),
        ("Fan", "😍", "Loves everything about you"),
        ("Questioner", "🤔", "Curious and investigative"),
        ("Hater", "😠", "Dislikes everything"),
        ("Flirtatious", "😏", "Flirty and playful"),
        ("Intellectual", "🧠", "Shares deep thoughts"),
        ("Chaotic", "🌀", "Wild energy"),
        ("Supporter", "🤝", "Encouraging and positive"),
        ("Critic", "🎯", "Constructive feedback"),
        ("Emotional", "😢", "Feels everything"),
        ("Sarcastic", "😒", "Dry humor expert"),
        ("Motivator", "💪", "Pumps everyone up")
    ]

    private let viewerPacks = [
        (label: "5,000", viewers: 5_000, cost: 15),
        (label: "20,000", viewers: 20_000, cost: 50),
        (label: "45,000", viewers: 45_000, cost: 100),
        (label: "75,000", viewers: 75_000, cost: 150),
        (label: "150,000", viewers: 150_000, cost: 250),
        (label: "400,000", viewers: 400_000, cost: 500)
    ]

    private let commentSlots = [
        ("general", "General", true),
        ("agree", "Agree", true),
        ("disagree", "Disagree", true),
        ("compliment", "Compliments", true),
        ("beauty", "Beauty", true),
        ("fashion", "Fashion", true),
        ("health", "Health", true),
        ("lifestyle", "Lifestyle", true),
        ("gifts", "Virtual Gifts", true)
    ]

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                topBar
                tabBar

                ScrollView {
                    Group {
                        switch activeTab {
                        case .basic:
                            basicTab
                        case .audience:
                            audienceTab
                        case .comments:
                            commentsTab
                        case .saved:
                            savedTab
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 18)
                }

                bottomBar
            }

            if showCountdown {
                Color.appBackground.ignoresSafeArea()
                Text(countdown > 0 ? "\(countdown)" : "🎙️")
                    .font(.system(size: 118, weight: .bold))
                    .foregroundStyle(.white)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .onDisappear {
            countdownTimer?.invalidate()
            countdownTimer = nil
        }
        .alert("Not enough coins", isPresented: $showCoinRechargeAlert) {
            Button("Recharge Coins", action: onShowCoinStore)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(insufficientCoinsMessage)
        }
    }

    private var topBar: some View {
        HStack {
            Button {
                onShowCoinStore()
            } label: {
                HStack(spacing: 7) {
                    CoinIcon(size: 22)
                    Text("\(preferences.coins)")
                        .font(.system(size: 14, weight: .black))
                        .foregroundStyle(.white)
                    Text("+")
                        .font(.system(size: 13, weight: .black))
                        .foregroundStyle(.white.opacity(0.65))
                }
                .padding(.horizontal, 12)
                .frame(height: 38)
                .background(Color(red: 0.78, green: 0.59, blue: 0.04), in: RoundedRectangle(cornerRadius: 12))
            }

            Spacer()

            HStack(spacing: 5) {
                Text("PARALLEL LIVE")
                    .font(.system(size: 15, weight: .black))
                    .foregroundStyle(.white)
                Circle().fill(Color.red).frame(width: 7, height: 7)
            }

            Spacer()

            Button(action: onShowVIP) {
                HStack(spacing: 6) {
                    Image(systemName: "crown.fill")
                        .foregroundStyle(Color.gold)
                    Text("VIP")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                }
                .padding(.horizontal, 13)
                .frame(height: 38)
                .background(Color.brandPurple.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.brandPurple.opacity(0.40)))
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 12)
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases, id: \.self) { tab in
                Button {
                    activeTab = tab
                } label: {
                    Text(tab.rawValue)
                        .font(.system(size: 13, weight: activeTab == tab ? .bold : .medium))
                        .foregroundStyle(activeTab == tab ? .white : .white.opacity(0.42))
                        .frame(maxWidth: .infinity)
                        .frame(height: 38)
                        .background(activeTab == tab ? .white.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
        .padding(4)
        .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }

    private var basicTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 13) {
                UserAvatarView(imageData: userAvatarData, size: 56)
                VStack(alignment: .leading, spacing: 3) {
                    Text(userName)
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                    Text("Your profile")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.52))
                }
                Spacer()
                Button("Edit", action: onEditProfile)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(height: 32)
                    .background(.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
            }
            .padding(14)
            .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.10)))

            VStack(alignment: .leading, spacing: 4) {
                Text("Set tone of the audience during your live session")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.82))
                Text("Choose one or more types to shape the vibe · \(preferences.selectedVibes.count) selected")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.brandPurple)
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                ForEach(vibes, id: \.0) { vibe in
                    let active = preferences.selectedVibes.contains(vibe.0)
                    Button {
                        toggleVibe(vibe.0)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(vibe.1).font(.system(size: 24))
                            Text(vibe.0)
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                            Text(vibe.2)
                                .font(.system(size: 10))
                                .foregroundStyle(.white.opacity(0.45))
                                .lineLimit(2)
                            Text(active ? "✓ Added" : "Add")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(active ? Color.brandPurple : .white.opacity(0.45))
                                .frame(maxWidth: .infinity)
                                .frame(height: 24)
                                .background(active ? Color.brandPurple.opacity(0.24) : .white.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                        }
                        .padding(10)
                        .frame(height: 128)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(active ? Color.brandPurple.opacity(0.16) : .white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(active ? Color.brandPurple.opacity(0.60) : .white.opacity(0.10), lineWidth: 1.5))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var audienceTab: some View {
        VStack(spacing: 16) {
            Button {
                onShowCoinStore()
            } label: {
                HStack(spacing: 12) {
                    CoinIcon(size: 32)
                    Text("Get more coins")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .foregroundStyle(.white.opacity(0.78))
                }
                .padding(14)
                .background(LinearGradient(colors: [Color(red: 0.78, green: 0.59, blue: 0.04), Color(red: 0.96, green: 0.77, blue: 0.09)], startPoint: .leading, endPoint: .trailing), in: RoundedRectangle(cornerRadius: 16))
            }

            Text("Your live session will have \(projectedViewerCount.formatted()) people joining within \(Int(preferences.lobbyArriveTime)) minute\(preferences.lobbyArriveTime == 1 ? "" : "s").")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white.opacity(0.62))
                .multilineTextAlignment(.center)

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                ForEach(viewerPacks, id: \.label) { pack in
                    let canAfford = preferences.coins >= pack.cost
                    let isSelected = preferences.selectedViewerPackLabel == pack.label || preferences.lobbyJoinCount == pack.viewers
                    Button {
                        preferences.selectedViewerPackLabel = pack.label
                        preferences.lobbyJoinCount = pack.viewers
                        if !canAfford {
                            showCoinRechargeAlert = true
                        }
                    } label: {
                        VStack(spacing: 5) {
                            Text(pack.label)
                                .font(.system(size: 15, weight: .black))
                                .foregroundStyle(.white)
                            Text("Viewers")
                                .font(.system(size: 11))
                                .foregroundStyle(.white.opacity(0.55))
                            HStack(spacing: 4) {
                                CoinIcon(size: 16)
                                Text("\(pack.cost)")
                                    .font(.system(size: 12, weight: .bold))
                            }
                            .foregroundStyle(canAfford ? Color.gold : Color.red.opacity(0.85))
                            .opacity(canAfford ? 1 : 0.58)

                            Text(isSelected ? "Selected" : (canAfford ? "Pay on Start" : "Need coins"))
                                .font(.system(size: 10, weight: .black))
                                .foregroundStyle(isSelected ? Color.green : .white.opacity(0.48))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 94)
                        .background(isSelected ? Color.brandPurple.opacity(0.18) : .white.opacity(canAfford ? 0.10 : 0.04), in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(isSelected ? Color.brandPurple.opacity(0.68) : .white.opacity(canAfford ? 0.18 : 0.07), lineWidth: isSelected ? 1.6 : 1))
                        .opacity(canAfford || isSelected ? 1 : 0.58)
                    }
                    .buttonStyle(.plain)
                }
            }

            if selectedViewerCost > 0 {
                HStack(spacing: 10) {
                    CoinIcon(size: 22)
                    Text("\(preferences.lobbyJoinCount.formatted()) viewers selected")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                    Spacer()
                    Text("\(selectedViewerCost) coins charged when live starts")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(preferences.coins >= selectedViewerCost ? .white.opacity(0.56) : Color.red.opacity(0.86))
                }
                .padding(14)
                .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.10)))
            }

            SliderBlock(title: "Viewer arrive time", value: $preferences.lobbyArriveTime, range: 1...60, step: 1, valueText: "\(Int(preferences.lobbyArriveTime)) min", minText: "1 min", maxText: "1 hr")
            SliderBlock(
                title: "How many viewers will join",
                value: Binding(
                    get: { Double(preferences.lobbyJoinCount) },
                    set: { value in
                        preferences.lobbyJoinCount = Int(value)
                        preferences.selectedViewerPackLabel = matchingViewerPackLabel(for: Int(value))
                    }
                ),
                range: 50...500000,
                step: 50,
                valueText: "\(preferences.lobbyJoinCount.formatted()) · \(selectedViewerCost) coins",
                minText: "50",
                maxText: "500k"
            )
        }
    }

    private var commentsTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 0), spacing: 10), count: 3), spacing: 10) {
                    ForEach(commentSlots, id: \.0) { slot in
                        let active = preferences.activeCommentCategories.contains(slot.0)
                        Button {
                            if slot.2 {
                                toggleCommentCategory(slot.0)
                            }
                        } label: {
                            Text(slot.1)
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(active ? .white : (slot.2 ? .white.opacity(0.55) : .white.opacity(0.20)))
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                                .frame(maxWidth: .infinity)
                                .frame(height: 62)
                                .background(active ? .white.opacity(0.18) : .white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
                                .overlay(RoundedRectangle(cornerRadius: 16).stroke(active ? .white.opacity(0.45) : .white.opacity(0.08), lineWidth: 1.4))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: .infinity)

                VStack(spacing: 12) {
                    SideToolButton(systemName: "photo")
                    SideToolButton(systemName: "mic.fill")
                    SideToolButton(systemName: "rectangle.inset.filled")
                    SideToolButton(systemName: "face.smiling")
                }
                .frame(width: 54)
            }

            InfoRow(icon: "text.bubble.fill", title: "AI reply direction", description: "Choose the topics AI viewers should focus on during your live stream. Selected directions will shape compliments, questions, agreement, disagreement, appearance reactions, lifestyle comments, and gift-related messages.")
        }
    }

    private var savedTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    Image(systemName: "square.and.arrow.up.fill")
                        .font(.system(size: 24, weight: .bold))
                        .foregroundStyle(Color.gold)
                        .frame(width: 48, height: 48)
                        .background(Color.gold.opacity(0.16), in: Circle())

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Share for bonus coins")
                            .font(.system(size: 22, weight: .black))
                            .foregroundStyle(.white)
                        Text("Submit a social share link or screenshot to get 100 coins instantly, once per day. Approved posts can earn up to 10k coins.")
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.62))
                            .lineSpacing(2)
                    }
                }

                HStack(spacing: 10) {
                    RewardRulePill(icon: "bolt.fill", title: "Daily submit", coins: "100")
                    RewardRulePill(icon: "checkmark.seal.fill", title: "Approved", coins: "10k")
                }
            }
            .padding(16)
            .background(LinearGradient(colors: [Color.brandPurple.opacity(0.22), Color.gold.opacity(0.12)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.12)))

            if let selectedVideo {
                rewardProofForm(for: selectedVideo)
            }

            if let savedVideoMessage {
                Text(savedVideoMessage)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(savedVideoMessage.contains("100 coins added") || savedVideoMessage.contains("Saved") ? Color.green : Color.gold)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.10)))
            }

            VStack(alignment: .leading, spacing: 12) {
                Text("Saved Videos")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(.white)

                if preferences.savedVideos.isEmpty {
                    EmptyStateCard(title: "No saved streams", message: "End a live session to save a watermarked video here.")
                } else {
                    ForEach(preferences.savedVideos) { video in
                        SavedVideoCard(
                            video: video,
                            isSelected: selectedRewardVideoID == video.id,
                            hasSubmission: preferences.rewardSubmissions.contains { $0.videoID == video.id },
                            onSelect: {
                                withAnimation(.easeInOut) {
                                    rewardVideoID = video.id
                                }
                            },
                            onDownload: {
                                downloadSavedVideo(video)
                            }
                        )
                    }
                }
            }

            VStack(alignment: .leading, spacing: 12) {
                Text("Reward Review")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(.white)

                if preferences.rewardSubmissions.isEmpty {
                    Text("Submitted proofs will appear here with review status. Coins are added after manual approval.")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.42))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.10)))
                } else {
                    ForEach(preferences.rewardSubmissions) { submission in
                        RewardSubmissionRow(submission: submission)
                    }
                }
            }
        }
    }

    private var selectedRewardVideoID: UUID? {
        rewardVideoID ?? preferences.savedVideos.first?.id
    }

    private var selectedVideo: SavedLiveVideo? {
        guard let id = selectedRewardVideoID else { return nil }
        return preferences.savedVideos.first { $0.id == id }
    }

    private func rewardProofForm(for video: SavedLiveVideo) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Submit Proof")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.white)

            Picker("Platform", selection: $rewardPlatform) {
                Text("TikTok").tag("TikTok")
                Text("Instagram").tag("Instagram")
            }
            .pickerStyle(.segmented)

            TextField("Paste post link", text: $rewardProofLink)
                .disableAutocorrection(true)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .frame(height: 48)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.12)))

#if os(iOS)
            PhotosPicker(selection: $selectedRewardScreenshot, matching: .images) {
                HStack(spacing: 10) {
                    Image(systemName: rewardScreenshotData == nil ? "photo.badge.plus" : "checkmark.circle.fill")
                    Text(rewardScreenshotData == nil ? "Upload screenshot proof" : "Screenshot attached")
                    Spacer()
                }
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(rewardScreenshotData == nil ? .white.opacity(0.72) : Color.green)
                .padding(.horizontal, 14)
                .frame(height: 48)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.12)))
            }
            .onChange(of: selectedRewardScreenshot) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let compressed = await compressProofImageData(data) {
                        await MainActor.run {
                            rewardScreenshotData = compressed
                        }
                    }
                }
            }
#else
            Text("Screenshot upload is available on iPhone. Paste a public post link to submit proof.")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.48))
#endif

            Button {
                submitRewardProof(for: video)
            } label: {
                HStack {
                    Image(systemName: "paperplane.fill")
                    Text("Submit for review")
                }
                .font(.system(size: 15, weight: .black))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(canSubmitRewardProof ? Color.green : .white.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
            }
            .disabled(!canSubmitRewardProof)
        }
        .padding(16)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.10)))
    }

    private var canSubmitRewardProof: Bool {
        !rewardProofLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || rewardScreenshotData != nil
    }

    private func downloadSavedVideo(_ video: SavedLiveVideo) {
#if os(iOS)
        let image = renderSavedVideoReceipt(video)
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async {
                    savedVideoMessage = "Photo access is needed to save locally."
                }
                return
            }

            PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            } completionHandler: { success, _ in
                DispatchQueue.main.async {
                    if success {
                        markSavedVideoDownloaded(video.id)
                        savedVideoMessage = "Saved to Photos with SquadLive watermark."
                    } else {
                        savedVideoMessage = "Could not save locally. Please try again."
                    }
                }
            }
        }
#else
        savedVideoMessage = "Download is available on iPhone."
#endif
    }

    private func markSavedVideoDownloaded(_ videoID: UUID) {
        guard let index = preferences.savedVideos.firstIndex(where: { $0.id == videoID }) else { return }
        preferences.savedVideos[index].downloadedAt = Date()
        PersistenceStore.savePreferences(preferences)
    }

    private var projectedViewerCount: Int {
        preferences.lobbyJoinCount
    }

    private var selectedViewerCost: Int {
        viewerCost(for: preferences.lobbyJoinCount)
    }

    private var insufficientCoinsMessage: String {
        "\(preferences.lobbyJoinCount.formatted()) viewers costs \(selectedViewerCost) coins. You currently have \(preferences.coins) coins."
    }

    private var bottomBar: some View {
        HStack(alignment: .center) {
            Button {
                activeTab = .saved
                rewardVideoID = preferences.savedVideos.first?.id
            } label: {
                HStack(spacing: 8) {
                    CoinIcon(size: 20)
                    Text("Earn 10k fans by sharing!")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.white.opacity(0.70))
                        .lineLimit(2)
                }
                .padding(.horizontal, 12)
                .frame(width: 140, height: 48)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.12)))
            }
            .buttonStyle(.plain)
            .contentShape(RoundedRectangle(cornerRadius: 16))

            Spacer()

            VStack(spacing: 5) {
                Button {
                    startCountdown()
                } label: {
                    ZStack {
                        Circle()
                            .fill(.black.opacity(0.88))
                            .frame(width: 66, height: 66)
                            .overlay(Circle().stroke(.white.opacity(0.16), lineWidth: 3))
                            .shadow(color: .red.opacity(0.36), radius: 18)
                        Circle()
                            .fill(RadialGradient(colors: [.red.opacity(0.96), Color(red: 0.75, green: 0, blue: 0)], center: .topLeading, startRadius: 4, endRadius: 30))
                            .frame(width: 42, height: 42)
                    }
                }
                Text("Start")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.white.opacity(0.70))
            }

            Spacer()

            Color.clear.frame(width: 140, height: 48)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 24)
        .background(.black.opacity(0.42))
        .overlay(alignment: .top) {
            Rectangle().fill(.white.opacity(0.07)).frame(height: 1)
        }
    }

    private func toggleVibe(_ id: String) {
        if preferences.selectedVibes.contains(id) {
            preferences.selectedVibes.removeAll { $0 == id }
        } else {
            preferences.selectedVibes.append(id)
        }
    }

    private func toggleCommentCategory(_ id: String) {
        if preferences.activeCommentCategories.contains(id) {
            if preferences.activeCommentCategories.count > 1 {
                preferences.activeCommentCategories.removeAll { $0 == id }
            }
        } else {
            preferences.activeCommentCategories.append(id)
        }
    }

    private func matchingViewerPackLabel(for viewers: Int) -> String? {
        viewerPacks.first { $0.viewers == viewers }?.label
    }

    private func viewerCost(for viewers: Int) -> Int {
        let freeViewers = 500
        guard viewers > freeViewers else { return 0 }

        let anchors = [(viewers: freeViewers, cost: 0)] + viewerPacks.map { (viewers: $0.viewers, cost: $0.cost) }
        for index in 1..<anchors.count {
            let lower = anchors[index - 1]
            let upper = anchors[index]
            if viewers <= upper.viewers {
                let progress = Double(viewers - lower.viewers) / Double(upper.viewers - lower.viewers)
                let rawCost = Double(lower.cost) + progress * Double(upper.cost - lower.cost)
                return max(1, Int(ceil(rawCost)))
            }
        }

        let highest = anchors[anchors.count - 1]
        let extraViewers = viewers - highest.viewers
        let extraCost = Double(extraViewers) * Double(highest.cost) / Double(highest.viewers)
        return highest.cost + Int(ceil(extraCost))
    }

    private func startCountdown() {
        let cost = selectedViewerCost
        if cost > 0 {
            guard preferences.coins >= cost else {
                showCoinRechargeAlert = true
                return
            }

            preferences.coins -= cost
            preferences.selectedViewerPackLabel = nil
        }

        countdownTimer?.invalidate()
        showCountdown = true
        countdown = 3
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { timer in
            if countdown <= 1 {
                countdown = 0
                timer.invalidate()
                countdownTimer = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    showCountdown = false
                    onGoLive()
                }
            } else {
                countdown -= 1
            }
        }
    }

    private func submitRewardProof(for video: SavedLiveVideo) {
        let cleanLink = rewardProofLink.trimmingCharacters(in: .whitespacesAndNewlines)
        let shouldGrantDailyBonus = !hasShareSubmissionToday
        let submission = RewardSubmission(
            videoID: video.id,
            platform: rewardPlatform,
            proofLink: cleanLink,
            screenshotData: rewardScreenshotData,
            estimatedRewardCoins: 10_000
        )

        if shouldGrantDailyBonus {
            preferences.coins += 100
        }
        preferences.rewardSubmissions.insert(submission, at: 0)
        preferences.rewardSubmissions = Array(preferences.rewardSubmissions.prefix(50))
        AppReviewStrategy.register(.shareSubmitted, preferences: &preferences)
        savedVideoMessage = shouldGrantDailyBonus ? "Share submitted. 100 coins added for today's daily bonus." : "Share submitted. Daily 100 coin bonus already claimed today."
        rewardProofLink = ""
        rewardScreenshotData = nil
#if os(iOS)
        selectedRewardScreenshot = nil
#endif
    }

    private var hasShareSubmissionToday: Bool {
        preferences.rewardSubmissions.contains { submission in
            Calendar.current.isDate(submission.submittedAt, inSameDayAs: Date())
        }
    }
}

private struct SliderBlock: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    let valueText: String
    let minText: String
    let maxText: String

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.72))
                Spacer()
                Text(valueText)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
            }
            Slider(value: $value, in: range, step: step)
                .tint(Color.brandPurple)
            HStack {
                Text(minText)
                Spacer()
                Text(maxText)
            }
            .font(.system(size: 11))
            .foregroundStyle(.white.opacity(0.30))
        }
        .padding(16)
        .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.10)))
    }
}

private struct CoinStoreView: View {
    let coins: Int
    let onClose: () -> Void
    let onBuy: (Int) -> Void
    @State private var purchaseMessage: String?
    @State private var selectedPackCoins = 525

    private let packs = [
        (coins: 330, rate: "66.1 coins/$1", bonus: nil as String?, badge: nil as String?, price: "$4.99", highlighted: false),
        (coins: 420, rate: "70.1 coins/$1", bonus: "+6% bonus", badge: nil, price: "$5.99", highlighted: false),
        (coins: 525, rate: "75.1 coins/$1", bonus: "+14% bonus", badge: "Best Value", price: "$6.99", highlighted: true),
        (coins: 740, rate: "82.3 coins/$1", bonus: "+24% bonus", badge: nil, price: "$8.99", highlighted: false),
        (coins: 1_450, rate: "90.7 coins/$1", bonus: "+37% bonus", badge: "Popular", price: "$15.99", highlighted: false),
        (coins: 1_800, rate: "94.8 coins/$1", bonus: "+43% bonus", badge: "Most Coins", price: "$18.99", highlighted: false)
    ]

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.62)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture(perform: onClose)

            VStack(spacing: 13) {
                Capsule()
                    .fill(.white.opacity(0.28))
                    .frame(width: 50, height: 4)

                HStack(spacing: 12) {
                    CoinIcon(size: 30)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Coin Store")
                            .font(.system(size: 22, weight: .black))
                            .foregroundStyle(.white)
                        Text("Spend coins to boost your stream")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(.white.opacity(0.46))
                    }
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white.opacity(0.70))
                            .frame(width: 64, height: 64)
                            .background(.white.opacity(0.10), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .frame(width: 72, height: 72)
                    .contentShape(Rectangle())
                    .zIndex(20)
                }

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 12) {
                        ForEach(packs, id: \.coins) { pack in
                            CoinStorePackRow(
                                coins: pack.coins,
                                rate: pack.rate,
                                bonus: pack.bonus,
                                badge: pack.badge,
                                price: pack.price,
                                highlighted: pack.highlighted,
                                isSelected: selectedPackCoins == pack.coins
                            ) {
                                selectedPackCoins = pack.coins
                                onBuy(pack.coins)
                                purchaseMessage = "+\(pack.coins.formatted()) coins added."
                            }
                        }

                        if let purchaseMessage {
                            Text(purchaseMessage)
                                .font(.system(size: 14, weight: .black))
                                .foregroundStyle(Color.green)
                                .frame(maxWidth: .infinity)
                                .frame(height: 38)
                                .background(.white.opacity(0.07), in: Capsule())
                        }

                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "bolt.fill")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(Color.gold)
                            Text("Coins are added instantly. Prices are in USD. Purchases are final and non-refundable.")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(.white.opacity(0.32))
                                .lineSpacing(3)
                            Spacer()
                        }
                        .padding(.top, 8)
                        .padding(.bottom, 8)
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .padding(.bottom, 18)
            .background(Color(red: 0.045, green: 0.050, blue: 0.080), in: UnevenRoundedRectangle(topLeadingRadius: 28, bottomLeadingRadius: 8, bottomTrailingRadius: 8, topTrailingRadius: 28))
            .overlay(UnevenRoundedRectangle(topLeadingRadius: 28, bottomLeadingRadius: 8, bottomTrailingRadius: 8, topTrailingRadius: 28).stroke(.white.opacity(0.10)))
            .ignoresSafeArea(edges: .bottom)
            .zIndex(2)
        }
    }
}

private struct CoinStorePackRow: View {
    let coins: Int
    let rate: String
    let bonus: String?
    let badge: String?
    let price: String
    let highlighted: Bool
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                HStack(spacing: 12) {
                    CoinIcon(size: 34)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(coins.formatted())
                            .font(.system(size: 24, weight: .black))
                            .foregroundStyle(isSelected && highlighted ? Color(red: 1.0, green: 0.57, blue: 0.36) : Color.gold)
                        HStack(spacing: 6) {
                            Text(rate)
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(.white.opacity(0.38))
                                .lineLimit(1)
                                .minimumScaleFactor(0.86)
                            if let bonus {
                                Text(bonus)
                                    .font(.system(size: 10, weight: .black))
                                    .foregroundStyle(Color.green)
                                    .padding(.horizontal, 7)
                                    .frame(height: 20)
                                    .background(Color.green.opacity(0.20), in: Capsule())
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.78)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Text(price)
                        .font(.system(size: 15, weight: .black))
                        .foregroundStyle(.white)
                        .frame(width: 92, height: 44)
                        .background(LinearGradient(colors: [Color.brandPurple, Color.brandPurpleDark], startPoint: .topLeading, endPoint: .bottomTrailing), in: Capsule())
                        .shadow(color: Color.brandPurple.opacity(0.24), radius: 10)
                        .padding(.top, badge == nil ? 0 : 14)
                }
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity)
                .frame(height: 84)
                .background(rowBackground, in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(borderColor, lineWidth: isSelected ? 2 : 1))

                if let badge {
                    Text(badge)
                        .font(.system(size: 11, weight: .black))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)
                        .padding(.horizontal, 10)
                        .frame(height: 24)
                        .background(badgeColor, in: Capsule())
                        .padding(.top, 8)
                        .padding(.trailing, 12)
                }
            }
        }
        .buttonStyle(.plain)
        .contentShape(RoundedRectangle(cornerRadius: 18))
    }

    private var rowBackground: some ShapeStyle {
        if isSelected {
            return AnyShapeStyle(LinearGradient(colors: [Color(red: 0.22, green: 0.11, blue: 0.11), Color(red: 0.14, green: 0.08, blue: 0.08)], startPoint: .leading, endPoint: .trailing))
        }
        return AnyShapeStyle(Color.white.opacity(highlighted ? 0.085 : 0.07))
    }

    private var borderColor: Color {
        if isSelected {
            return highlighted ? Color.brandOrange : Color.brandPurple
        }
        return .white.opacity(0.12)
    }

    private var badgeColor: Color {
        badge == "Best Value" ? Color.brandOrange : Color.brandPurple
    }
}

private struct SideToolButton: View {
    let systemName: String

    var body: some View {
        Button {} label: {
            Image(systemName: systemName)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white.opacity(0.60))
                .frame(width: 42, height: 42)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

private struct EmptyStateCard: View {
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.white)
            Text(message)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white.opacity(0.28))
                .frame(maxWidth: .infinity)
                .frame(height: 96)
                .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.10)))
        }
    }
}

private struct RewardRulePill: View {
    let icon: String
    let title: String
    let coins: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .bold))
            Text(title)
                .font(.system(size: 13, weight: .bold))
            Spacer()
            Text("+\(coins)")
                .font(.system(size: 13, weight: .black))
                .foregroundStyle(Color.gold)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .frame(height: 42)
        .background(.black.opacity(0.24), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.10)))
    }
}

private struct CoinIcon: View {
    var size: CGFloat = 18

    var body: some View {
        Image("CoinIcon")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityLabel("Coins")
    }
}

private struct SavedVideoCard: View {
    let video: SavedLiveVideo
    let isSelected: Bool
    let hasSubmission: Bool
    let onSelect: () -> Void
    let onDownload: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                RoundedRectangle(cornerRadius: 14)
                    .fill(LinearGradient(colors: [.black.opacity(0.55), Color.brandPurple.opacity(0.45)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 86, height: 112)
                    .overlay(alignment: .center) {
                        Image(systemName: "video.fill")
                            .font(.system(size: 26, weight: .bold))
                            .foregroundStyle(.white.opacity(0.72))
                    }
                Text(video.watermark)
                    .font(.system(size: 8, weight: .black))
                    .foregroundStyle(.white.opacity(0.86))
                    .padding(.horizontal, 5)
                    .frame(height: 18)
                    .background(.black.opacity(0.52), in: Capsule())
                    .padding(7)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(video.createdAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)

                HStack(spacing: 10) {
                    Label(formatSavedDuration(video.durationSeconds), systemImage: "clock.fill")
                    Label(video.peakPopularity.formatted(), systemImage: "person.2.fill")
                }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white.opacity(0.54))

                Text(video.downloadedAt == nil ? "Not downloaded yet" : "Downloaded to local")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(video.downloadedAt == nil ? .white.opacity(0.46) : Color.green)

                Text(hasSubmission ? "Proof submitted" : "Ready for TikTok or Instagram reward proof")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(hasSubmission ? Color.green : Color.gold)
            }

            Spacer()

            VStack(spacing: 10) {
                Button(action: onDownload) {
                    Image(systemName: video.downloadedAt == nil ? "arrow.down.circle.fill" : "checkmark.circle.fill")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(video.downloadedAt == nil ? Color.brandPurple : Color.green)
                }
                .buttonStyle(.plain)

                Image(systemName: isSelected ? "checkmark.circle.fill" : "chevron.right")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(isSelected ? Color.green : .white.opacity(0.35))
            }
        }
        .padding(12)
        .background(isSelected ? Color.brandPurple.opacity(0.17) : .white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(isSelected ? Color.brandPurple.opacity(0.58) : .white.opacity(0.10), lineWidth: 1.4))
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
    }
}

private struct RewardSubmissionRow: View {
    let submission: RewardSubmission

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: submission.platform == "TikTok" ? "music.note" : "camera.fill")
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(Color.green.opacity(0.20), in: Circle())

            VStack(alignment: .leading, spacing: 5) {
                Text("\(submission.platform) · \(submission.status)")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                Text("+\(submission.estimatedRewardCoins.formatted()) coins after approval")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.gold)
                Text(submission.submittedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.38))
            }

            Spacer()

            if submission.screenshotData != nil {
                Image(systemName: "photo.fill")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white.opacity(0.54))
            }
        }
        .padding(14)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.10)))
    }
}

private func formatSavedDuration(_ seconds: Int) -> String {
    let minutes = seconds / 60
    let remainder = seconds % 60
    return String(format: "%d:%02d", minutes, remainder)
}

#if os(iOS)
private func compressProofImageData(_ data: Data) async -> Data? {
    guard let image = UIImage(data: data) else { return nil }
    let maxSide: CGFloat = 900
    let sourceSize = image.size
    let scale = min(maxSide / max(sourceSize.width, sourceSize.height), 1)
    let targetSize = CGSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
    let renderer = UIGraphicsImageRenderer(size: targetSize)
    let rendered = renderer.image { _ in
        image.draw(in: CGRect(origin: .zero, size: targetSize))
    }
    return rendered.jpegData(compressionQuality: 0.72)
}

private func renderSavedVideoReceipt(_ video: SavedLiveVideo) -> UIImage {
    let size = CGSize(width: 1080, height: 1920)
    let renderer = UIGraphicsImageRenderer(size: size)
    return renderer.image { context in
        let rect = CGRect(origin: .zero, size: size)
        UIColor(red: 0.045, green: 0.050, blue: 0.080, alpha: 1).setFill()
        context.fill(rect)

        let colors = [
            UIColor(red: 0.616, green: 0.518, blue: 1, alpha: 0.95).cgColor,
            UIColor(red: 1, green: 0.498, blue: 0.314, alpha: 0.88).cgColor
        ]
        let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])
        context.cgContext.drawLinearGradient(gradient!, start: CGPoint(x: 0, y: 0), end: CGPoint(x: size.width, y: size.height), options: [])

        let cardRect = CGRect(x: 96, y: 340, width: 888, height: 880)
        let cardPath = UIBezierPath(roundedRect: cardRect, cornerRadius: 56)
        UIColor.black.withAlphaComponent(0.52).setFill()
        cardPath.fill()

        let titleAttributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 78, weight: .black),
            .foregroundColor: UIColor.white
        ]
        "SquadLive".draw(in: CGRect(x: 140, y: 420, width: 800, height: 100), withAttributes: titleAttributes)

        let subtitleAttributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 36, weight: .semibold),
            .foregroundColor: UIColor.white.withAlphaComponent(0.72)
        ]
        "Saved Live Stream".draw(in: CGRect(x: 140, y: 535, width: 800, height: 54), withAttributes: subtitleAttributes)

        let statAttributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedDigitSystemFont(ofSize: 44, weight: .bold),
            .foregroundColor: UIColor.white
        ]
        let mutedAttributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 28, weight: .semibold),
            .foregroundColor: UIColor.white.withAlphaComponent(0.58)
        ]

        drawReceiptStat(title: "Duration", value: formatSavedDuration(video.durationSeconds), y: 680, statAttributes: statAttributes, mutedAttributes: mutedAttributes)
        drawReceiptStat(title: "Peak viewers", value: video.peakPopularity.formatted(), y: 835, statAttributes: statAttributes, mutedAttributes: mutedAttributes)
        drawReceiptStat(title: "Created", value: video.createdAt.formatted(date: .abbreviated, time: .shortened), y: 990, statAttributes: statAttributes, mutedAttributes: mutedAttributes)

        let watermarkAttributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 34, weight: .black),
            .foregroundColor: UIColor.white.withAlphaComponent(0.62)
        ]
        "\(video.watermark) watermark".draw(in: CGRect(x: 140, y: 1135, width: 800, height: 56), withAttributes: watermarkAttributes)

        let footerAttributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 30, weight: .bold),
            .foregroundColor: UIColor.white.withAlphaComponent(0.86)
        ]
        "Share this watermarked record on TikTok or Instagram for review.".draw(in: CGRect(x: 120, y: 1580, width: 840, height: 100), withAttributes: footerAttributes)
    }
}

private func drawReceiptStat(title: String, value: String, y: CGFloat, statAttributes: [NSAttributedString.Key: Any], mutedAttributes: [NSAttributedString.Key: Any]) {
    title.draw(in: CGRect(x: 140, y: y, width: 360, height: 44), withAttributes: mutedAttributes)
    value.draw(in: CGRect(x: 140, y: y + 48, width: 760, height: 64), withAttributes: statAttributes)
}
#endif

private struct EditProfileView: View {
    let profile: UserProfile
    let onBack: () -> Void
    let onSave: (UserProfile) -> Void

    @State private var draft: UserProfile
#if os(iOS)
    @State private var selectedPhoto: PhotosPickerItem?
#endif

    init(profile: UserProfile, onBack: @escaping () -> Void, onSave: @escaping (UserProfile) -> Void) {
        self.profile = profile
        self.onBack = onBack
        self.onSave = onSave
        _draft = State(initialValue: profile)
    }

    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: "Edit Profile", onBack: onBack)

            ScrollView {
                VStack(spacing: 18) {
                    VStack(spacing: 12) {
                        UserAvatarView(imageData: draft.userAvatarData, size: 96)

#if os(iOS)
                        PhotosPicker(selection: $selectedPhoto, matching: .images) {
                            Label(draft.userAvatarData == nil ? "Upload Your Avatar" : "Change Avatar", systemImage: "photo.on.rectangle")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 16)
                                .frame(height: 40)
                                .background(Color.brandPurple, in: Capsule())
                        }
                        .onChange(of: selectedPhoto) { _, item in
                            guard let item else { return }
                            Task {
                                if let data = try? await item.loadTransferable(type: Data.self),
                                   let compressed = await compressAvatarImageData(data) {
                                    await MainActor.run {
                                        draft.userAvatarData = compressed
                                    }
                                }
                            }
                        }
#else
                        Text("Avatar upload is available on iPhone.")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.white.opacity(0.55))
#endif
                    }

                    VStack(spacing: 14) {
                        FormField(title: "Name", text: $draft.name, placeholder: "Friend")
                        OptionPicker(title: "Age", options: ["under18", "18-24", "25-34", "35-44", "45+"], selection: $draft.age)
                        OptionPicker(title: "Pronoun", options: ["he", "she", "they"], selection: $draft.pronoun)
                        OptionPicker(title: "Focus", options: ["work", "relationship", "lonely", "hype"], selection: $draft.mood)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 18)
                .padding(.bottom, 24)
            }

            PrimaryButton(title: "Save Changes") {
                onSave(draft)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 30)
        }
    }
}

private struct AppSettingsView: View {
    @Binding var preferences: AppPreferences
    let onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: "Settings", onBack: onBack)

            ScrollView {
                VStack(spacing: 14) {
                    SettingToggleRow(icon: "lock.fill", title: "Private Mode", description: "Keep sessions local and AI-only.", isOn: $preferences.privateMode)
                    SettingToggleRow(icon: "sparkles", title: "Supportive Prompts", description: "Show gentle suggestions during quiet moments.", isOn: $preferences.supportivePrompts)
                    SettingToggleRow(icon: "wand.and.stars", title: "Soft Animations", description: "Use calmer motion across the experience.", isOn: $preferences.softAnimations)

                    InfoRow(icon: "shield.fill", title: "Data", description: "SquadLive saves your profile and session settings on this device.")
                }
                .padding(.horizontal, 24)
                .padding(.top, 18)
                .padding(.bottom, 30)
            }
        }
    }
}

private struct AllListenersView: View {
    let listeners: [Listener]
    @Binding var selectedListener: Listener
    let onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: "AI Listeners", onBack: onBack)

            ScrollView {
                VStack(spacing: 14) {
                    ForEach(listeners) { listener in
                        Button {
                            selectedListener = listener
                            onBack()
                        } label: {
                            HStack(spacing: 14) {
                                Text(listener.avatar)
                                    .font(.system(size: 38))
                                    .frame(width: 58, height: 58)
                                    .background(LinearGradient(colors: [.brandPurple.opacity(0.28), .brandOrange.opacity(0.20)], startPoint: .topLeading, endPoint: .bottomTrailing), in: Circle())

                                VStack(alignment: .leading, spacing: 5) {
                                    Text(listener.name)
                                        .font(.system(size: 18, weight: .semibold))
                                        .foregroundStyle(.white)
                                    Text(listener.role)
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(Color.brandOrange)
                                    Text(listener.description)
                                        .font(.system(size: 13))
                                        .foregroundStyle(.white.opacity(0.62))
                                        .lineLimit(2)
                                }

                                Spacer()

                                Image(systemName: selectedListener == listener ? "checkmark.circle.fill" : "chevron.right")
                                    .foregroundStyle(selectedListener == listener ? Color.brandPurple : .white.opacity(0.38))
                            }
                            .padding(16)
                            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
                            .overlay(RoundedRectangle(cornerRadius: 18).stroke(selectedListener == listener ? Color.brandPurple : .white.opacity(0.10), lineWidth: selectedListener == listener ? 2 : 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 18)
                .padding(.bottom, 30)
            }
        }
    }
}

private struct MoodCheckInView: View {
    @Binding var preferences: AppPreferences
    let onBack: () -> Void

    private let moods = ["Overwhelmed", "Lonely", "Hopeful", "Tired", "Anxious", "Calm"]

    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: "Mood Check-in", onBack: onBack)

            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("How are you arriving today?")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(.white)

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 2), spacing: 10) {
                        ForEach(moods, id: \.self) { mood in
                            Button {
                                preferences.lastMood = mood
                            } label: {
                                Text(mood)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(preferences.lastMood == mood ? .white : .white.opacity(0.70))
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 48)
                                    .background(preferences.lastMood == mood ? Color.brandPurple : .white.opacity(0.06), in: Capsule())
                                    .overlay(Capsule().stroke(preferences.lastMood == mood ? Color.brandPurple : .white.opacity(0.12)))
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Intensity")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(.white)
                        Slider(value: $preferences.lastMoodIntensity, in: 1...10, step: 1)
                            .tint(Color.brandPurple)
                        HStack {
                            Text("Gentle")
                            Spacer()
                            Text("\(Int(preferences.lastMoodIntensity))/10")
                            Spacer()
                            Text("Intense")
                        }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.54))
                    }
                    .padding(18)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.10)))

                    InfoRow(icon: "heart.fill", title: "Suggested Session", description: "Start with Sarah for validation and grounding before moving into practical next steps.")
                }
                .padding(.horizontal, 24)
                .padding(.top, 18)
                .padding(.bottom, 24)
            }

            PrimaryButton(title: "Save Check-in", action: onBack)
                .padding(.horizontal, 24)
                .padding(.bottom, 30)
        }
    }
}

private struct SessionSettingsView: View {
    @Binding var preferences: AppPreferences
    let onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: "Session Settings", onBack: onBack)

            ScrollView {
                VStack(spacing: 14) {
                    SettingToggleRow(icon: "text.bubble.fill", title: "AI Comments", description: "Let AI supporters react during the stream.", isOn: $preferences.commentsEnabled)
                    SettingToggleRow(icon: "heart.fill", title: "Floating Hearts", description: "Show tap-to-send heart reactions.", isOn: $preferences.heartsEnabled)
                    SettingToggleRow(icon: "lock.fill", title: "PRO Reminder", description: "Show a premium response preview during long sessions.", isOn: $preferences.autoPaywall)

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Free Session Length")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.white)
                        Slider(value: $preferences.sessionLength, in: 10...60, step: 5)
                            .tint(Color.brandPurple)
                        Text("\(Int(preferences.sessionLength)) seconds before PRO prompt")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.white.opacity(0.58))
                    }
                    .padding(18)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.10)))
                }
                .padding(.horizontal, 24)
                .padding(.top, 18)
                .padding(.bottom, 24)
            }

            PrimaryButton(title: "Done", action: onBack)
                .padding(.horizontal, 24)
                .padding(.bottom, 30)
        }
    }
}

private struct LiveStreamView: View {
    let listener: Listener
    let preferences: AppPreferences
    let initialPopularity: Int
    let purchasedAudienceCount: Int
    @Binding var showPaywall: Bool
    let onEnd: (Int, Int) -> Void
    let onShowCoinStore: () -> Void
    let onUpgrade: () -> Void

    @StateObject private var speechTranscriber = SpeechTranscriber()
    @State private var popularity: Int
    @State private var coins: Int
    @State private var isRecording = true
    @State private var showExitConfirm = false
    @State private var comments: [ChatComment] = []
    @State private var showBanner = true
    @State private var streamTime = 0
    @State private var hearts: [FloatingHeart] = []
    @State private var activeGifts: [ActiveGiftEffect] = []
    @State private var commentTimer: Timer?
    @State private var popularityTimer: Timer?
    @State private var giftTimer: Timer?
    @State private var clockTimer: Timer?
    @State private var heartTimer: Timer?
    @State private var warmupTimer: Timer?
    @State private var lastProcessedTranscript = ""
    @State private var lastDeepAnswerTime = -120
    @State private var deepAnswerInFlight = false
    @State private var openingCommentIndex = 0
    @State private var openingAudienceWaves = 0
    @State private var showLiveToolPanel = false
    @State private var selectedLiveTool: LiveToolTab = .tone
    @State private var liveQuickPrompt = ""
    @State private var aiRoleMode = "Supportive"
    @State private var aiReplyDepth = 0.62
    @State private var audienceEnergy = 0.54
    @State private var beautyFilter = 0.36
    @State private var giftIntensity = 0.42
    @State private var liveToneTopics = ["General"]
    @State private var liveVibeMoods = ["Hype", "Happy"]
    @State private var selectedFilter = "None"
    @State private var autoFakeDonations = true
    @State private var selectedGiftIndexes: [Int] = []
    @State private var liveToolMessage: String?
    @State private var audienceBoostUntil = 0
    @State private var audienceTargetPopularity: Int?
    @State private var paywallCooldownUntil = 0

    private let aiComments = [
        ("Emma", "👩", "That confidence looks good on you."),
        ("Jake", "👨", "Your energy is really clear today."),
        ("Lily", "👧", "I love how honest you are being."),
        ("Marcus", "🧔", "That was a strong point."),
        ("Sofia", "👱‍♀️", "You explain things in such a real way."),
        ("Ryan", "👨‍🦰", "The room is locked in with you."),
        ("Zoe", "👩‍🦱", "That felt personal and powerful."),
        ("Alex", "🧑", "Keep going, this is resonating.")
    ]
    private let openingComments = [
        ("Emma", "👩", "Hi, we are here with you."),
        ("Jake", "👨", "You already look comfortable on camera."),
        ("Lily", "👧", "Your vibe is warm today.")
    ]
    private let viewerJoinComments = [
        ("Mia", "👋", "came in to watch"),
        ("Noah", "🔥", "joined from the live feed"),
        ("Ava", "💫", "is watching now"),
        ("Chloe", "🫶", "just entered the room"),
        ("Harper", "✨", "is watching now"),
        ("Nora", "💬", "came in to listen"),
        ("Ivy", "⚡️", "joined the live"),
        ("Sophia", "👑", "just arrived")
    ]
    private let commentAvatarURLMap = [
        "Emma": "https://randomuser.me/api/portraits/women/44.jpg",
        "Lily": "https://randomuser.me/api/portraits/women/68.jpg",
        "Sofia": "https://randomuser.me/api/portraits/women/32.jpg",
        "Zoe": "https://randomuser.me/api/portraits/women/26.jpg",
        "Mia": "https://randomuser.me/api/portraits/women/21.jpg",
        "Ava": "https://randomuser.me/api/portraits/women/79.jpg",
        "Chloe": "https://randomuser.me/api/portraits/women/53.jpg",
        "Harper": "https://randomuser.me/api/portraits/women/65.jpg",
        "Nora": "https://randomuser.me/api/portraits/women/36.jpg",
        "Ivy": "https://randomuser.me/api/portraits/women/7.jpg",
        "Sophia": "https://randomuser.me/api/portraits/women/44.jpg",
        "Jake": "https://randomuser.me/api/portraits/men/32.jpg",
        "Marcus": "https://randomuser.me/api/portraits/men/46.jpg",
        "Ryan": "https://randomuser.me/api/portraits/men/22.jpg",
        "Alex": "https://randomuser.me/api/portraits/men/65.jpg",
        "Noah": "https://randomuser.me/api/portraits/men/11.jpg"
    ]
    private var avatarFrames: [AvatarFrameAsset] {
        let bundledNames = BundleResourceLookup.urls(forExtension: "svga", subdirectory: "AvatarFrames")
            .map { $0.deletingPathExtension().lastPathComponent }
        let names = (bundledNames.isEmpty ? fallbackAvatarFrameNames : bundledNames)
            .filter { allowedAvatarFrameNames.contains($0) }
        return Array(Set(names)).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            .map { AvatarFrameAsset(baseName: $0) }
    }
    private let fallbackAvatarFrameNames = [
        "1", "11", "12", "14", "15", "89", "90", "96", "199", "215",
        "15680945477675", "15680945580374", "156809458999", "15680946104757",
        "15681723369495", "15682830713063", "15876152207053", "15876152971169"
    ]
    private let allowedAvatarFrameNames = Set([
        "1", "11", "12", "14", "15", "89", "90", "96", "199", "215",
        "15680945477675", "15680945580374", "156809458999", "15680946104757",
        "15681723369495", "15682830713063", "15876152207053", "15876152971169"
    ])
    private let heartEmojis = ["❤️", "🩷", "🧡", "💛", "💚", "💙", "🩵", "💜", "🤎"]
    private let giftSenders = ["Emma", "Jake", "Lily", "Marcus", "Sofia", "Ryan", "Zoe", "Alex"]
    private let giftAssets = [
        GiftAnimationAsset(baseName: "1", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (14)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (17)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (30加快速度)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (33)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (42)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (66)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (68)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (80)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (84)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (90)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "1 (93)", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "act", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "act的副本", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "act的副本 2", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "act的副本 3", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "act的副本 4", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "act的副本 5", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "act的副本 6", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "heart_of_the_sea", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "kiss", format: .webp, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "cover的副本 3", format: .png, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "love", format: .png, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "头花", format: .png, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "小熊", format: .png, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "玫瑰花束", format: .png, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "鞋", format: .png, subdirectory: "GiftEffects"),
        GiftAnimationAsset(baseName: "香水", format: .png, subdirectory: "GiftEffects")
    ]

    init(listener: Listener, preferences: AppPreferences, initialPopularity: Int, purchasedAudienceCount: Int, showPaywall: Binding<Bool>, onEnd: @escaping (Int, Int) -> Void, onShowCoinStore: @escaping () -> Void, onUpgrade: @escaping () -> Void) {
        self.listener = listener
        self.preferences = preferences
        self.initialPopularity = initialPopularity
        self.purchasedAudienceCount = purchasedAudienceCount
        self._showPaywall = showPaywall
        self.onEnd = onEnd
        self.onShowCoinStore = onShowCoinStore
        self.onUpgrade = onUpgrade
        self._popularity = State(initialValue: max(100, initialPopularity))
        self._coins = State(initialValue: preferences.coins)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            CameraPreview()
                .ignoresSafeArea()
            LinearGradient(colors: [.brandPurple.opacity(0.20), .black.opacity(0.22), .black.opacity(0.78)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                VStack(spacing: 12) {
                    ZStack(alignment: .top) {
                        HStack {
                            liveCoinButton
                            Spacer()
                            liveProBadge
                        }

                        liveStatusBadge
                    }

                    if showBanner {
                        HStack(spacing: 10) {
                            Text("🎉").font(.system(size: 24))
                            Text(isRecording ? "Your stream is live! People are tuning in." : "Press GO LIVE when you're ready to start!")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(.white)
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 52)
                        .background(LinearGradient(colors: [.brandPurple.opacity(0.92), .brandOrange.opacity(0.92)], startPoint: .leading, endPoint: .trailing), in: RoundedRectangle(cornerRadius: 18))
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 16)

                ZStack {
                    if !isRecording {
                        VStack(spacing: 14) {
                            FramedAIAvatar(imageURL: listener.imageURL, frameAsset: avatarFrameForListener)
                            Text("\(listener.name) is listening...")
                                .font(.system(size: 18, weight: .medium))
                                .foregroundStyle(.white.opacity(0.82))
                        }
                    }

                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                VStack(spacing: 12) {
                    if preferences.commentsEnabled && isRecording {
                        VStack(spacing: 8) {
                            ForEach(Array(comments.suffix(6).enumerated()), id: \.element.id) { index, comment in
                                LiveCommentRow(
                                    comment: comment,
                                    imageURL: commentImageURL(for: comment),
                                    frameAsset: avatarFrame(for: comment.name),
                                    isPremium: isPremiumComment(comment)
                                )
                                .opacity(min(1.0, 0.82 + Double(index) * 0.035))
                                .transition(.asymmetric(
                                    insertion: .move(edge: .leading).combined(with: .opacity).combined(with: .scale(scale: 0.96)),
                                    removal: .move(edge: .bottom).combined(with: .opacity)
                                ))
                            }
                        }
                        .frame(maxHeight: 260, alignment: .bottom)
                        .clipped()
                    }
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 10)

                if showLiveToolPanel {
                    LiveToolPanel(
                        selectedTool: $selectedLiveTool,
                        quickPrompt: $liveQuickPrompt,
                        aiRoleMode: $aiRoleMode,
                        aiReplyDepth: $aiReplyDepth,
                        audienceEnergy: $audienceEnergy,
                        beautyFilter: $beautyFilter,
                        giftIntensity: $giftIntensity,
                        toneTopics: $liveToneTopics,
                        vibeMoods: $liveVibeMoods,
                        selectedFilter: $selectedFilter,
                        autoFakeDonations: $autoFakeDonations,
                        selectedGiftIndexes: $selectedGiftIndexes,
                        listener: listener,
                        coins: coins,
                        message: liveToolMessage,
                        giftAssets: giftAssets,
                        onSendPrompt: sendLiveToolPrompt,
                        onBuyViewers: buyLiveViewers,
                        onClose: {
                            withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                                showLiveToolPanel = false
                            }
                        }
                    )
                    .padding(.horizontal, 18)
                    .padding(.bottom, 10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                HStack {
                    Button {
                        withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                            showLiveToolPanel.toggle()
                        }
                    } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(showLiveToolPanel ? .white : .white.opacity(0.72))
                            .frame(width: 44, height: 44)
                            .background(showLiveToolPanel ? Color.brandPurple.opacity(0.36) : .white.opacity(0.10), in: Circle())
                            .overlay(Circle().stroke(showLiveToolPanel ? Color.brandPurple.opacity(0.72) : .clear, lineWidth: 1.4))
                    }
                    .buttonStyle(.plain)
                    .contentShape(Circle())

                    Spacer()

                    VStack(spacing: 5) {
                        Button {
                            isRecording.toggle()
                            if isRecording {
                                showBanner = true
                                DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                                    withAnimation { showBanner = false }
                                }
                            }
                        } label: {
                            ZStack {
                                Circle()
                                    .fill(isRecording ? Color.red : .black.opacity(0.82))
                                    .frame(width: 66, height: 66)
                                    .overlay(Circle().stroke(.white.opacity(0.18), lineWidth: isRecording ? 0 : 3))
                                    .shadow(color: .red.opacity(isRecording ? 0.65 : 0.32), radius: 22)
                                if isRecording {
                                    RoundedRectangle(cornerRadius: 5)
                                        .fill(.white)
                                        .frame(width: 20, height: 20)
                                } else {
                                    Circle()
                                        .fill(Color.red)
                                        .frame(width: 30, height: 30)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .contentShape(Circle())
                        Text(isRecording ? "STOP" : "GO LIVE")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(isRecording ? Color.red.opacity(0.85) : .white.opacity(0.48))
                    }

                    Spacer()

                    Button {
                        showExitConfirm = true
                    } label: {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(Color.red.opacity(0.78))
                            .frame(width: 44, height: 44)
                            .background(Color.red.opacity(0.15), in: Circle())
                            .overlay(Circle().stroke(Color.red.opacity(0.28)))
                    }
                    .buttonStyle(.plain)
                    .contentShape(Circle())
                }
                .padding(.horizontal, 38)
                .padding(.bottom, 16)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)

            ForEach(activeGifts) { gift in
                GiftEffectView(gift: gift)
                    .transition(.scale.combined(with: .opacity))
            }

            if preferences.heartsEnabled && isRecording {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        ZStack {
                            ForEach(hearts) { heart in
                                FloatingHeartView(heart: heart)
                            }
                        }
                        .frame(width: 180, height: 260)
                        .padding(.trailing, 8)
                        .padding(.bottom, 98)
                    }
                }
                .allowsHitTesting(false)
            }

            if showPaywall {
                PaywallBanner(
                    listener: listener,
                    onClose: {
                        paywallCooldownUntil = streamTime + 180
                        withAnimation(.easeOut(duration: 0.25)) {
                            showPaywall = false
                        }
                    },
                    onUpgrade: onUpgrade
                )
                    .padding(.horizontal, 24)
                    .padding(.bottom, 118)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if showExitConfirm {
                ExitStreamConfirmView(
                    onCancel: { showExitConfirm = false },
                    onEnd: { onEnd(streamTime, popularity) }
                )
                .transition(.opacity)
            }
        }
        .onAppear {
            startTimers()
            speechTranscriber.start()
        }
        .onChange(of: isRecording) { _, newValue in
            handleRecordingChanged(newValue)
        }
        .onDisappear {
            stopTimers()
            speechTranscriber.stop()
        }
    }

    private func startTimers() {
        stopTimers()
        showBanner = true
        comments = []
        streamTime = 0
        activeGifts = []
        lastProcessedTranscript = ""
        lastDeepAnswerTime = -120
        deepAnswerInFlight = false
        openingCommentIndex = 0
        openingAudienceWaves = 0
        preloadLiveAvatars()

        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            withAnimation { showBanner = false }
        }

        if preferences.commentsEnabled {
            scheduleNextBarrage(initialDelay: true)
        }
        configurePurchasedAudienceRamp()
        scheduleOpeningAudienceWarmup()

        popularityTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { timer in
            guard isRecording else { return }
            let delta = nextPopularityDelta()
            popularity = max(popularityFloor, min(popularityCeiling, popularity + delta))
            if let target = audienceTargetPopularity, popularity >= target {
                audienceTargetPopularity = nil
            }
            if preferences.commentsEnabled && (delta > 90 || isAudienceBoostActive) && Int.random(in: 0...100) < (isAudienceBoostActive ? 62 : 32) {
                appendViewerJoinComment()
            }
        }

        giftTimer?.invalidate()
        giftTimer = nil
        heartTimer?.invalidate()
        heartTimer = nil

        clockTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { timer in
            guard isRecording else { return }
            streamTime += 1
            maybeRequestDeepAnswer()
            let paywallStartTime = max(Int(preferences.sessionLength), 90)
            if preferences.autoPaywall && streamTime >= paywallStartTime && streamTime >= paywallCooldownUntil && !showPaywall && !showLiveToolPanel {
                withAnimation { showPaywall = true }
            }
        }

        if isRecording {
            handleRecordingChanged(true)
        }
    }

    private func handleRecordingChanged(_ newValue: Bool) {
        if newValue {
            if preferences.heartsEnabled {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                    sendHeart()
                }
            }
            scheduleNextAutoHeart(initialDelay: true)
            scheduleFirstLiveGift()
        } else {
            heartTimer?.invalidate()
            heartTimer = nil
            giftTimer?.invalidate()
            giftTimer = nil
            hearts.removeAll()
        }
    }

    private var liveCoinButton: some View {
        Button {
            onShowCoinStore()
        } label: {
            HStack(spacing: 5) {
                CoinIcon(size: 18)
                Text("\(coins)")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.gold)
                Text("+")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Color.gold.opacity(0.55))
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(.black.opacity(0.52), in: Capsule())
            .overlay(Capsule().stroke(Color.gold.opacity(0.28)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var liveStatusBadge: some View {
        VStack(spacing: 5) {
            HStack(spacing: 7) {
                Circle()
                    .fill(isRecording ? Color.red : Color.gray)
                    .frame(width: 8, height: 8)
                    .opacity(isRecording ? 1 : 0.75)
                Text(isRecording ? "LIVE" : "OFFLINE")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                if isRecording {
                    Text(formatTime(streamTime))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.62))
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 32)
            .background(.black.opacity(0.52), in: Capsule())

            if isRecording {
                PopularityBadge(value: popularity)
            }
        }
        .frame(maxWidth: .infinity)
        .allowsHitTesting(false)
    }

    private var liveProBadge: some View {
        Button(action: onUpgrade) {
            Text("PRO")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .frame(height: 32)
                .background(LinearGradient(colors: [.brandPurple, .brandOrange], startPoint: .leading, endPoint: .trailing), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func stopTimers() {
        commentTimer?.invalidate()
        popularityTimer?.invalidate()
        giftTimer?.invalidate()
        clockTimer?.invalidate()
        heartTimer?.invalidate()
        warmupTimer?.invalidate()
        commentTimer = nil
        popularityTimer = nil
        giftTimer = nil
        clockTimer = nil
        heartTimer = nil
        warmupTimer = nil
    }

    private func preloadLiveAvatars() {
#if os(iOS)
        var urls = Array(commentAvatarURLMap.values)
        urls.append(listener.imageURL)
        RemoteImageCache.prefetch(urlStrings: urls)
#endif
    }

    private func scheduleOpeningAudienceWarmup() {
        warmupTimer?.invalidate()
        guard isRecording else { return }

        let interval: Double
        if isAudienceBoostActive {
            interval = Double.random(in: 1.1...2.2)
        } else {
            switch streamTime {
            case 0..<12:
                interval = Double.random(in: 0.32...0.68)
            case 12..<35:
                interval = Double.random(in: 0.58...1.05)
            case 35..<120:
                interval = Double.random(in: 1.1...2.0)
            case 120..<600:
                interval = Double.random(in: 2.0...3.8)
            default:
                interval = Double.random(in: 3.0...5.8)
            }
        }

        warmupTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { timer in
            timer.invalidate()
            guard isRecording else { return }
            applyOpeningAudienceWave()
            scheduleOpeningAudienceWarmup()
        }
    }

    private func configurePurchasedAudienceRamp() {
        guard purchasedAudienceCount > 0 else { return }
        audienceTargetPopularity = min(500_000, popularity + purchasedAudienceCount)
        audienceBoostUntil = streamTime + max(120, min(420, purchasedAudienceCount / 180))
    }

    private func applyOpeningAudienceWave() {
        openingAudienceWaves += 1

        let joinCount: Int
        if purchasedAudienceCount > 0 {
            switch streamTime {
            case 0..<12:
                joinCount = Int.random(in: 90...420)
            case 12..<35:
                joinCount = Int.random(in: 70...320)
            case 35..<180:
                joinCount = Int.random(in: 45...240)
            default:
                joinCount = Int.random(in: 35...180)
            }
        } else if isAudienceBoostActive {
            joinCount = Int.random(in: 80...520)
        } else {
            switch streamTime {
            case 0..<12:
                joinCount = Int.random(in: 35...120)
            case 12..<35:
                joinCount = Int.random(in: 26...95)
            case 35..<120:
                joinCount = Int.random(in: 18...70)
            case 120..<600:
                joinCount = Int.random(in: 12...58)
            default:
                let currentScale = max(1, min(8, popularity / 4_000))
                joinCount = Int.random(in: 8...(34 + currentScale * 18))
            }
        }

        popularity = min(popularityCeiling, popularity + joinCount)
        audienceEnergy = min(1.0, audienceEnergy + Double.random(in: 0.006...0.018))

        guard preferences.commentsEnabled else { return }
        if openingAudienceWaves <= 18 || openingAudienceWaves.isMultiple(of: Int.random(in: 2...4)) || isAudienceBoostActive {
            appendViewerJoinComment()
        }
        if openingAudienceWaves.isMultiple(of: streamTime < 180 ? 5 : 8) {
            appendBarrageComment()
        }
    }

    private func scheduleNextBarrage(initialDelay: Bool = false) {
        commentTimer?.invalidate()
        let interval = initialDelay ? Double.random(in: 2.4...4.2) : nextBarrageInterval()
        commentTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { timer in
            timer.invalidate()
            if isRecording && preferences.commentsEnabled {
                appendBarrageComment()
            }
            scheduleNextBarrage()
        }
    }

    private func nextBarrageInterval() -> Double {
        if isAudienceBoostActive {
            return Double.random(in: 1.2...2.4)
        }

        if deepAnswerInFlight {
            return Double.random(in: 4.8...7.5)
        }

        if streamTime - lastDeepAnswerTime < 18 {
            return Double.random(in: 5.0...8.0)
        }

        switch popularity {
        case 120_000...:
            return Double.random(in: 1.8...3.2)
        case 50_000...:
            return Double.random(in: 2.2...3.8)
        case 10_000...:
            return Double.random(in: 2.8...4.8)
        default:
            return streamTime > 240 ? Double.random(in: 3.2...5.4) : Double.random(in: 2.8...4.8)
        }
    }

    private func appendBarrageComment() {
        let item: (String, String, String)
        if openingCommentIndex < openingComments.count {
            item = openingComments[openingCommentIndex]
            openingCommentIndex += 1
        } else {
            item = contextualBarrageComment()
        }

        withAnimation {
            comments.append(ChatComment(name: item.0, avatar: item.1, text: item.2, kind: .barrage))
            comments = Array(comments.suffix(6))
        }
        expireComment(comments.last?.id, after: 6.5)
    }

    private func appendViewerJoinComment() {
        let item = viewerJoinComments.randomElement() ?? viewerJoinComments[0]
        withAnimation {
            comments.append(ChatComment(name: item.0, avatar: item.1, text: item.2, kind: .barrage))
            comments = Array(comments.suffix(8))
        }
        expireComment(comments.last?.id, after: 5.0)
    }

    private var popularityCeiling: Int {
        if let target = audienceTargetPopularity {
            return max(target, popularity + 2_000)
        }

        if isAudienceBoostActive {
            return max(500_000, popularity + 80_000)
        }

        let organicCeiling = organicPopularityTarget + max(2_500, organicPopularityTarget / 5)
        switch max(initialPopularity, popularity) {
        case 150_000...:
            return min(500_000, max(organicCeiling, max(initialPopularity + 55_000, Int(Double(initialPopularity) * 1.28))))
        case 50_000...:
            return min(500_000, max(organicCeiling, max(initialPopularity + 38_000, Int(Double(initialPopularity) * 1.42))))
        case 5_000...:
            return min(500_000, max(organicCeiling, max(initialPopularity + 18_000, Int(Double(initialPopularity) * 2.1))))
        case 1_000...:
            return min(500_000, max(organicCeiling, initialPopularity + 12_000))
        default:
            return min(500_000, max(organicCeiling, initialPopularity + 9_000))
        }
    }

    private var popularityFloor: Int {
        let organicFloor = Int(Double(organicPopularityTarget) * 0.62)
        switch max(initialPopularity, popularity) {
        case 50_000...:
            return max(organicFloor, max(1_000, Int(Double(initialPopularity) * 0.82)))
        case 5_000...:
            return max(organicFloor, max(800, Int(Double(initialPopularity) * 0.72)))
        case 1_000...:
            return max(organicFloor, max(650, Int(Double(initialPopularity) * 0.70)))
        default:
            return max(organicFloor, max(180, Int(Double(initialPopularity) * 0.72)))
        }
    }

    private var organicPopularityTarget: Int {
        let minutes = max(0.0, Double(streamTime) / 60.0)
        let base = max(initialPopularity, preferences.isPremiumMember ? 20_000 : 520)
        let earlyLift = preferences.isPremiumMember ? 28_000.0 : 5_800.0
        let earlyCurve = earlyLift * (1.0 - exp(-minutes / 16.0))
        let steadyGrowth = minutes * (preferences.isPremiumMember ? 125.0 : 38.0)
        let longSessionBonus = max(0.0, minutes - 25.0) * (preferences.isPremiumMember ? 48.0 : 18.0)
        let purchasedTail = Double(purchasedAudienceCount) * min(1.0, minutes / 18.0)
        let energyBoost = Double(base) * min(0.45, max(0.0, audienceEnergy - 0.5) * 0.55)
        return min(500_000, Int(Double(base) + earlyCurve + steadyGrowth + longSessionBonus + purchasedTail + energyBoost))
    }

    private func nextPopularityDelta() -> Int {
        let scale = max(0.65, min(18.0, Double(max(popularity, initialPopularity)) / 5_000.0))
        if let target = audienceTargetPopularity, target > popularity {
            let remaining = target - popularity
            let roll = Int.random(in: 0...100)
            if roll < 14 {
                return -Int(Double.random(in: 8...38) * max(1.0, min(6.0, scale)))
            }
            let plannedStep = max(24, min(2_800, remaining / 24))
            return plannedStep + Int.random(in: -24...120)
        }

        let organicTarget = organicPopularityTarget
        if organicTarget > popularity {
            let remaining = organicTarget - popularity
            let roll = Int.random(in: 0...100)
            if roll < 12 {
                return -Int(Double.random(in: 5...24) * min(4.0, scale))
            }
            let plannedStep = max(18, min(streamTime < 180 ? 520 : 240, remaining / (streamTime < 240 ? 16 : 34)))
            return plannedStep + Int.random(in: 0...80)
        }

        if isAudienceBoostActive {
            let boostScale = max(1.0, min(8.0, scale))
            let roll = Int.random(in: 0...100)
            if roll < 18 {
                return -Int(Double.random(in: 60...260) * boostScale)
            }
            if roll < 68 {
                return Int(Double.random(in: 220...980) * boostScale)
            }
            return Int(Double.random(in: -40...180) * boostScale)
        }
        if streamTime < 8 {
            return Int(Double.random(in: 28...92) * scale)
        }

        let roll = Int.random(in: 0...100)
        if roll < 24 {
            return -Int(Double.random(in: 6...38) * scale)
        }
        if roll < 70 {
            return Int(Double.random(in: 18...92) * scale)
        }
        return Int(Double.random(in: -10...56) * scale)
    }

    private var isAudienceBoostActive: Bool {
        streamTime < audienceBoostUntil
    }

    private var avatarFrameForListener: AvatarFrameAsset {
        avatarFrame(for: listener.id)
    }

    private func avatarFrame(for key: String) -> AvatarFrameAsset {
        let frames = avatarFrames
        let index = stableIndex(for: key, count: max(frames.count, 1))
        return frames[index]
    }

    private func stableIndex(for key: String, count: Int) -> Int {
        guard count > 0 else { return 0 }
        var hash = 2_166_136_261
        for scalar in key.unicodeScalars {
            hash = (hash ^ Int(scalar.value)) &* 16_777_619
        }
        return abs(hash) % count
    }

    private func commentImageURL(for comment: ChatComment) -> String? {
        if comment.kind == .deepAnswer {
            return listener.imageURL
        }

        return commentAvatarURLMap[comment.name]
    }

    private func isPremiumComment(_ comment: ChatComment) -> Bool {
        comment.avatar == "🎁" || ["Emma", "Lily", "Ryan", "Zoe"].contains(comment.name)
    }

    private func contextualBarrageComment() -> (String, String, String) {
        let transcript = speechTranscriber.transcript.lowercased()

        if transcript.contains("sad") || transcript.contains("tired") || transcript.contains("stress") || transcript.contains("worried") {
            return [("Sofia", "👱‍♀️", "That sounds heavy, but you are saying it clearly."), ("Emma", "👩", "We are staying with you through this.")].randomElement() ?? aiComments[0]
        }

        if transcript.contains("happy") || transcript.contains("excited") || transcript.contains("proud") {
            return [("Zoe", "👩‍🦱", "That joy is showing on your face."), ("Ryan", "👨‍🦰", "This is the energy we came for.")].randomElement() ?? aiComments[0]
        }

        let activeDirections = preferences.activeCommentCategories.filter { $0 != "slot1" && $0 != "slot2" && $0 != "slot3" }
        let direction = activeDirections.randomElement() ?? "general"
        return commentsForDirection(direction).randomElement() ?? aiComments[0]
    }

    private func commentsForDirection(_ direction: String) -> [(String, String, String)] {
        switch direction {
        case "agree":
            return [
                ("Jake", "👨", "Exactly, that makes sense."),
                ("Sofia", "👱‍♀️", "I agree with the way you said that."),
                ("Alex", "🧑", "That point is landing with us.")
            ]
        case "disagree":
            return [
                ("Marcus", "🧔", "I see it a little differently."),
                ("Zoe", "👩‍🦱", "Maybe there is another angle here."),
                ("Ryan", "👨‍🦰", "Push back a bit, but keep going.")
            ]
        case "compliment":
            return [
                ("Emma", "👩", "You are really natural on camera."),
                ("Lily", "👧", "Your confidence feels effortless."),
                ("Sofia", "👱‍♀️", "You have a warm presence.")
            ]
        case "beauty":
            return [
                ("Zoe", "👩‍🦱", "Your look is glowing right now."),
                ("Emma", "👩", "The camera loves this angle."),
                ("Lily", "👧", "Your smile just changed the room.")
            ]
        case "fashion":
            return [
                ("Ryan", "👨‍🦰", "That outfit has a real creator vibe."),
                ("Sofia", "👱‍♀️", "The styling feels intentional."),
                ("Alex", "🧑", "The whole look is working.")
            ]
        case "health":
            return [
                ("Maya", "🧘‍♀️", "Take a breath, your pace feels good."),
                ("Emma", "👩", "Your calm energy is coming through."),
                ("Marcus", "🧔", "This is a good moment to slow down.")
            ]
        case "lifestyle":
            return [
                ("Jake", "👨", "That routine sounds relatable."),
                ("Lily", "👧", "This feels like a real-life update."),
                ("Zoe", "👩‍🦱", "Your day-to-day stories are easy to follow.")
            ]
        case "gifts":
            return [
                ("Sofia", "🎁", "This deserves a gift boost."),
                ("Ryan", "🎁", "Sending support for that moment."),
                ("Alex", "🎁", "The room wants to celebrate you.")
            ]
        default:
            return aiComments
        }
    }

    private func maybeRequestDeepAnswer() {
        guard !deepAnswerInFlight else { return }
        guard streamTime - lastDeepAnswerTime >= 10 else { return }

        let cleanTranscript = speechTranscriber.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanTranscript.count >= 10 else { return }
        guard cleanTranscript != lastProcessedTranscript else { return }

        let newSegment = cleanTranscript.replacingOccurrences(of: lastProcessedTranscript, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = newSegment.count >= 18 ? newSegment : cleanTranscript
        guard shouldSendToDeepSeek(prompt) else { return }

        lastProcessedTranscript = cleanTranscript
        deepAnswerInFlight = true

        Task {
            let remoteAnswer = await DeepSeekClient.answer(
                userText: prompt,
                listener: listener,
                roleMode: aiRoleMode,
                replyDepth: aiReplyDepth,
                activeDirections: preferences.activeCommentCategories,
                toneTopics: liveToneTopics,
                vibeMoods: liveVibeMoods,
                liveSeconds: streamTime
            )
            let answer = remoteAnswer ?? localDeepAnswer(for: prompt)
            await MainActor.run {
                deepAnswerInFlight = false
                guard isRecording else { return }
                appendDeepAnswer(answer)
                lastDeepAnswerTime = streamTime
            }
        }
    }

    private func sendLiveToolPrompt() {
        let prompt = liveQuickPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        liveQuickPrompt = ""
        deepAnswerInFlight = true

        Task {
            let remoteAnswer = await DeepSeekClient.answer(
                userText: prompt,
                listener: listener,
                roleMode: aiRoleMode,
                replyDepth: aiReplyDepth,
                activeDirections: preferences.activeCommentCategories,
                toneTopics: liveToneTopics,
                vibeMoods: liveVibeMoods,
                liveSeconds: streamTime
            )
            let answer = remoteAnswer ?? localDeepAnswer(for: prompt)
            await MainActor.run {
                deepAnswerInFlight = false
                appendDeepAnswer(answer)
                lastDeepAnswerTime = streamTime
            }
        }
    }

    private func buyLiveViewers(viewers: Int, cost: Int) {
        guard coins >= cost else {
            liveToolMessage = "Not enough coins. Recharge coins to add viewers."
            return
        }

        coins -= cost
        let target = min(500_000, popularity + viewers)
        let firstWave = min(max(Int(Double(viewers) * 0.10), 300), 10_000)
        popularity = min(target, popularity + firstWave)
        audienceTargetPopularity = target
        audienceBoostUntil = streamTime + max(150, min(480, viewers / 180))
        liveToolMessage = "\(viewers.formatted()) viewers are joining now."
        appendViewerJoinComment()
        appendViewerJoinComment()
        if autoFakeDonations {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                if isRecording {
                    triggerAIGift()
                    scheduleNextAIGift()
                }
            }
        }
        if preferences.commentsEnabled {
            scheduleNextBarrage()
        }
    }

    private func shouldSendToDeepSeek(_ text: String) -> Bool {
        let lowercased = text.lowercased()
        if text.contains("?") || text.contains("？") {
            return true
        }

        let triggers = ["why", "how", "what should", "should i", "feel", "feeling", "because", "problem", "stress", "worried", "anxious", "sad", "angry", "relationship", "work", "family", "friend", "voice", "sound", "pretty", "beautiful", "good looking", "nice", "cute", "camera", "look"]
        return triggers.contains { lowercased.contains($0) }
    }

    private func appendDeepAnswer(_ text: String) {
        withAnimation {
            comments.append(ChatComment(name: listener.name, avatar: listener.avatar, text: text, kind: .deepAnswer))
            comments = Array(comments.suffix(4))
        }
        expireComment(comments.last?.id, after: 9.0)
    }

    private func expireComment(_ id: UUID?, after delay: Double) {
        guard let id else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            withAnimation(.easeOut(duration: 0.35)) {
                comments.removeAll { $0.id == id }
            }
        }
    }

    private func localDeepAnswer(for text: String) -> String {
        let lowercased = text.lowercased()
        if lowercased.contains("voice") || lowercased.contains("sound") || lowercased.contains("好听") {
            return "Your voice sounds really pleasant and easy to listen to. It makes the room feel calmer."
        }
        if lowercased.contains("pretty") || lowercased.contains("beautiful") || lowercased.contains("cute") || lowercased.contains("look") || lowercased.contains("好看") {
            return "You look really good on camera. The expression and the lighting both work well together."
        }
        if lowercased.contains("stress") || lowercased.contains("worried") || lowercased.contains("anxious") {
            return "I hear the pressure in that. Try naming the one part you can control right now, then let the rest wait for one minute."
        }
        if lowercased.contains("relationship") || lowercased.contains("friend") || lowercased.contains("family") {
            return "That sounds personal, so slow it down. A clear boundary plus one honest sentence may help more than trying to fix everything at once."
        }
        if lowercased.contains("why") || lowercased.contains("how") || lowercased.contains("what") {
            return "That is a real question. Start with the smallest version of it, because the first useful answer is usually hidden in one concrete detail."
        }
        return "I am listening to the deeper part of what you said. You do not need to perform it perfectly; say the next true sentence."
    }

    private func scheduleNextAIGift(initialDelay: Bool = false) {
        giftTimer?.invalidate()
        let interval = initialDelay ? Double.random(in: 20...34) : nextGiftInterval()
        giftTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { timer in
            timer.invalidate()
            if isRecording && autoFakeDonations {
                triggerAIGift()
            }
            scheduleNextAIGift()
        }
    }

    private func scheduleFirstLiveGift() {
        giftTimer?.invalidate()
        let interval = Double.random(in: 4.6...5.6)
        giftTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { timer in
            timer.invalidate()
            if isRecording && autoFakeDonations {
                triggerAIGift()
            }
            scheduleNextAIGift()
        }
    }

    private func scheduleNextAutoHeart(initialDelay: Bool = false) {
        heartTimer?.invalidate()
        let interval = initialDelay ? Double.random(in: 2.0...5.0) : Double.random(in: 4.0...9.0)
        heartTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { timer in
            timer.invalidate()
            if isRecording && preferences.heartsEnabled {
                sendHeart()
                if Bool.random() {
                    DispatchQueue.main.asyncAfter(deadline: .now() + Double.random(in: 0.25...0.8)) {
                        if isRecording {
                            sendHeart()
                        }
                    }
                }
            }
            scheduleNextAutoHeart()
        }
    }

    private func nextGiftInterval() -> Double {
        if isAudienceBoostActive {
            return Double.random(in: 5.5...10.5)
        }

        let baseInterval: ClosedRange<Double>
        switch popularity {
        case 400_000...:
            baseInterval = 8...16
        case 150_000...:
            baseInterval = 10...20
        case 50_000...:
            baseInterval = 12...24
        case 5_000...:
            baseInterval = 16...30
        default:
            baseInterval = streamTime > 240 ? 18...34 : 14...28
        }
        let intensityMultiplier = 1.18 - min(max(giftIntensity, 0), 1) * 0.34
        return Double.random(in: baseInterval) * intensityMultiplier
    }

    private func triggerAIGift() {
        let selectedAssets = selectedGiftIndexes.compactMap { giftAssets[safe: $0] }
        let giftPool = (selectedAssets.isEmpty ? giftAssets : selectedAssets).filter { $0.resourceURL != nil }
        let asset = giftPool.randomElement() ?? giftAssets.first
        guard let asset, asset.resourceURL != nil else { return }
        let sender = giftSenders.randomElement() ?? "Emma"
        let gift = ActiveGiftEffect(asset: asset, senderName: sender)

        withAnimation(.spring(response: 0.35, dampingFraction: 0.78)) {
            activeGifts.append(gift)
            popularity = min(popularityCeiling, popularity + Int.random(in: 180...980))
            if preferences.commentsEnabled {
                comments.append(ChatComment(name: sender, avatar: "🎁", text: "sent you a little boost"))
                comments = Array(comments.suffix(8))
                expireComment(comments.last?.id, after: 5.5)
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) {
            withAnimation(.easeOut(duration: 0.25)) {
                activeGifts.removeAll { $0.id == gift.id }
            }
        }
    }

    private func sendHeart() {
        guard isRecording else { return }
        let heart = FloatingHeart(emoji: heartEmojis.randomElement() ?? "❤️", xOffset: CGFloat.random(in: -30...30))
        hearts.append(heart)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) {
            hearts.removeAll { $0.id == heart.id }
        }
    }

    private func formatTime(_ seconds: Int) -> String {
        let minutes = seconds / 60
        let remainder = seconds % 60
        return String(format: "%02d:%02d", minutes, remainder)
    }
}

private struct FloatingHeartView: View {
    let heart: FloatingHeart
    @State private var yOffset: CGFloat = 0
    @State private var xDrift: CGFloat = 0
    @State private var opacity = 1.0
    @State private var scale = 0.55

    var body: some View {
        Text(heart.emoji)
            .font(.system(size: 24))
            .scaleEffect(scale)
            .opacity(opacity)
            .offset(x: heart.xOffset + xDrift, y: yOffset)
            .onAppear {
                withAnimation(.easeOut(duration: 2.35)) {
                    yOffset = -340
                    xDrift = CGFloat.random(in: -28...28)
                    opacity = 0
                    scale = 1.0
                }
            }
    }
}

private struct FramedAIAvatar: View {
    let imageURL: String
    let frameAsset: AvatarFrameAsset

    var body: some View {
        ZStack {
            RemoteImage(urlString: imageURL)
                .frame(width: 126, height: 126)
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.26), lineWidth: 2))
                .shadow(color: .black.opacity(0.38), radius: 18)

            SVGAFrameView(resourceURL: frameAsset.resourceURL)
                .frame(width: 176, height: 176)
                .allowsHitTesting(false)
        }
        .frame(width: 176, height: 176)
    }
}

#if os(iOS)
private struct SVGAFrameView: UIViewRepresentable {
    let resourceURL: URL?

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.userContentController.add(context.coordinator, name: "svgaLog")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.isUserInteractionEnabled = false
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard let resourceURL else {
            NSLog("SquadLive SVGA frame missing resource URL")
            return
        }
        guard context.coordinator.lastURL != resourceURL else { return }
        guard let svgaData = try? Data(contentsOf: resourceURL) else {
            NSLog("SquadLive SVGA frame could not read asset: \(resourceURL.path)")
            return
        }
        guard let bundledPlayerURL = BundleResourceLookup.url(forResource: "svga-web-lite.min", extension: "js", subdirectory: "Media") else {
            NSLog("SquadLive SVGA frame missing Media/svga-web-lite.min.js in app bundle")
            return
        }
        guard let playerScript = try? String(contentsOf: bundledPlayerURL, encoding: .utf8) else {
            NSLog("SquadLive SVGA frame could not read SVGA Web Lite script")
            return
        }

        context.coordinator.lastURL = resourceURL
        let svgaBase64 = svgaData.base64EncodedString()
        let safePlayerScript = playerScript.replacingOccurrences(of: "</script", with: "<\\/script")
        let html = """
        <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
        html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; background: transparent; overflow: hidden; }
        #stage { position: fixed; inset: 0; width: 100vw; height: 100vh; background: transparent; overflow: hidden; }
        #canvas { position: absolute !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; background: transparent !important; }
        </style>
        <script>\(safePlayerScript)</script>
        </head>
        <body>
        <div id="stage"><canvas id="canvas"></canvas></div>
        <script>
        (function() {
          function nativeLog(message) {
            try {
              window.webkit.messageHandlers.svgaLog.postMessage(message);
            } catch (_) {
              console.log(message);
            }
          }
          window.onerror = function(message, source, line, column, error) {
            nativeLog('SVGA JS error: ' + message + ' at ' + line + ':' + column);
          };
          function startWhenReady() {
            var stage = document.getElementById('stage');
            if (!stage || stage.clientWidth < 2 || stage.clientHeight < 2) {
              requestAnimationFrame(startWhenReady);
              return;
            }
            startPlayer();
          }
          async function startPlayer() {
          try {
            var stage = document.getElementById('stage');
            var canvas = document.getElementById('canvas');
            var ratio = window.devicePixelRatio || 1;
            canvas.width = Math.max(2, Math.floor(stage.clientWidth * ratio));
            canvas.height = Math.max(2, Math.floor(stage.clientHeight * ratio));
            var parser = new SVGA.Parser({
              isDisableWebWorker: true,
              isDisableImageBitmapShim: true
            });
            var player = new SVGA.Player({
              container: canvas,
              loop: 0,
              isCacheFrames: true
            });
            var svga = await parser.load('data:svga/2.0;base64,\(svgaBase64)');
            await player.mount(svga);
            player.start();
            nativeLog('SVGA frame loaded with Web Lite: \(resourceURL.lastPathComponent)');
          } catch (error) {
            nativeLog('SVGA player failed: ' + error);
          }
          }
          startWhenReady();
        })();
        </script>
        </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        var lastURL: URL?

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            NSLog("SquadLive \(message.body)")
        }
    }
}
#else
private struct SVGAFrameView: View {
    let resourceURL: URL?

    var body: some View {
        EmptyView()
    }
}
#endif

private struct CommentAIAvatar: View {
    let name: String
    let fallbackEmoji: String
    let imageURL: String?
    let frameAsset: AvatarFrameAsset
    let isPremium: Bool

    var body: some View {
        ZStack {
            if let imageURL {
                RemoteImage(urlString: imageURL)
                    .frame(width: isPremium ? 35 : 31, height: isPremium ? 35 : 31)
                    .clipShape(Circle())
            } else {
                Text(fallbackEmoji)
                    .font(.system(size: isPremium ? 18 : 16))
                    .frame(width: isPremium ? 35 : 31, height: isPremium ? 35 : 31)
                    .background(.white.opacity(0.10), in: Circle())
            }

            SVGAFrameView(resourceURL: frameAsset.resourceURL)
                .frame(width: isPremium ? 66 : 60, height: isPremium ? 66 : 60)
                .allowsHitTesting(false)
        }
        .frame(width: 64, height: 64)
    }
}

private struct LiveCommentRow: View {
    let comment: ChatComment
    let imageURL: String?
    let frameAsset: AvatarFrameAsset
    let isPremium: Bool
    @State private var appeared = false

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            CommentAIAvatar(
                name: comment.name,
                fallbackEmoji: comment.avatar,
                imageURL: imageURL,
                frameAsset: frameAsset,
                isPremium: isPremium
            )

            ChatBubble(comment: comment)
        }
        .offset(x: appeared ? 0 : -22, y: appeared ? 0 : 8)
        .scaleEffect(appeared ? 1 : 0.96, anchor: .leading)
        .onAppear {
            withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) {
                appeared = true
            }
        }
    }
}

private struct ChatBubble: View {
    let comment: ChatComment

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Text(comment.name)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white.opacity(0.90))
                Circle()
                    .fill(comment.kind == .deepAnswer ? Color.brandPurple : .white.opacity(0.42))
                    .frame(width: comment.kind == .deepAnswer ? 6 : 4, height: comment.kind == .deepAnswer ? 6 : 4)
                if comment.kind == .deepAnswer {
                    Text("AI reply")
                        .font(.system(size: 10, weight: .black))
                        .foregroundStyle(Color.brandPurple)
                }
            }

            Text(comment.text)
                .font(.system(size: comment.kind == .deepAnswer ? 14 : 13))
                .foregroundStyle(.white.opacity(comment.kind == .deepAnswer ? 0.92 : 0.82))
                .lineSpacing(2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(comment.kind == .deepAnswer ? Color.brandPurple.opacity(0.18) : .black.opacity(0.62), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(comment.kind == .deepAnswer ? Color.brandPurple.opacity(0.65) : .white.opacity(0.08), lineWidth: 1.2))
    }
}

private struct LiveToolPanel: View {
    @Binding var selectedTool: LiveToolTab
    @Binding var quickPrompt: String
    @Binding var aiRoleMode: String
    @Binding var aiReplyDepth: Double
    @Binding var audienceEnergy: Double
    @Binding var beautyFilter: Double
    @Binding var giftIntensity: Double
    @Binding var toneTopics: [String]
    @Binding var vibeMoods: [String]
    @Binding var selectedFilter: String
    @Binding var autoFakeDonations: Bool
    @Binding var selectedGiftIndexes: [Int]
    let listener: Listener
    let coins: Int
    let message: String?
    let giftAssets: [GiftAnimationAsset]
    let onSendPrompt: () -> Void
    let onBuyViewers: (Int, Int) -> Void
    let onClose: () -> Void
    @State private var isExpanded = false

    private let toneTopicsData = ["General", "Agree", "Disagree", "Compliment", "Beauty", "Fashion", "Health", "Lifestyle", "Travel"]
    private let vibeData = [
        ("Haters", "😤", "Receive mean or rude comments"),
        ("Hype", "🔥", "Fans cheer you on loudly"),
        ("Happy", "😊", "Loyal fans are glad to see you"),
        ("Flirty", "😘", "Fans make you their priority"),
        ("Funny", "😂", "Viewers crack jokes all stream"),
        ("Curious", "🤔", "Q&A session, fans ask questions")
    ]
    private let viewerOptions = [
        ("+5,000", 5_000, 15),
        ("+20,000", 20_000, 50),
        ("+45,000", 45_000, 120),
        ("+100,000", 100_000, 200),
        ("+200,000", 200_000, 350),
        ("+400,000", 400_000, 500)
    ]
    private let filters = [
        ("Unicorn Mask", "🦄", 100),
        ("Owl Mask", "🦉", 100),
        ("Cyberpunk LED", "🤖", 100),
        ("Cool Shades", "😎", 100),
        ("Star Eyes", "⭐", 100),
        ("Cat Ears", "🐱", 100),
        ("Bunny Mask", "🐰", 100),
        ("Flower Crown", "🌸", 100),
        ("Fire Aura", "🔥", 100)
    ]
    private let giftNames = ["Rose", "Ice Cream", "Diamond", "Bouquet", "Koala", "Castle", "Yacht", "Rocket", "Space Koala"]
    private let giftPrices = [1, 1, 5, 10, 10, 50, 199, 499, 4_099]

    var body: some View {
        VStack(spacing: 14) {
            Capsule()
                .fill(.white.opacity(0.28))
                .frame(width: 48, height: 4)
                .padding(.top, 2)

            HStack {
                Text(panelTitle)
                    .font(.system(size: 22, weight: .black))
                    .foregroundStyle(.white)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white.opacity(0.68))
                        .frame(width: 48, height: 48)
                        .background(.white.opacity(0.12), in: Circle())
                }
                .buttonStyle(.plain)
                .contentShape(Circle())
            }

            HStack(spacing: 4) {
                ForEach(LiveToolTab.allCases, id: \.self) { tool in
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            selectedTool = tool
                        }
                    } label: {
                        VStack(spacing: 5) {
                            Image(systemName: tool.icon)
                                .font(.system(size: 17, weight: .semibold))
                            Text(tool.rawValue)
                                .font(.system(size: 10, weight: .bold))
                        }
                        .foregroundStyle(selectedTool == tool ? Color.brandPurple : .white.opacity(0.46))
                        .frame(maxWidth: .infinity)
                        .frame(height: 60)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }

            if let message {
                Text(message)
                    .font(.system(size: 12, weight: .black))
                    .foregroundStyle(message.contains("Not enough") ? Color.gold : Color.green)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .background(.white.opacity(0.07), in: Capsule())
            }

            ScrollView(showsIndicators: false) {
                toolContent
                    .padding(.bottom, 4)
            }
            .frame(height: contentHeight)
        }
        .padding(20)
        .background(Color(red: 0.045, green: 0.050, blue: 0.080), in: UnevenRoundedRectangle(topLeadingRadius: 28, bottomLeadingRadius: 8, bottomTrailingRadius: 8, topTrailingRadius: 28))
        .overlay(UnevenRoundedRectangle(topLeadingRadius: 28, bottomLeadingRadius: 8, bottomTrailingRadius: 8, topTrailingRadius: 28).stroke(.white.opacity(0.10)))
        .shadow(color: .black.opacity(0.36), radius: 24)
        .gesture(
            DragGesture(minimumDistance: 12)
                .onEnded { value in
                    if value.translation.height < -24 {
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                            isExpanded = true
                        }
                    } else if value.translation.height > 24 {
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                            isExpanded = false
                        }
                    }
                }
        )
    }

    private var panelTitle: String {
        switch selectedTool {
        case .tone: "💬 Tone — Barrage Topics"
        case .vibe: "✨ Vibe — Audience Mood"
        case .viewers: "👥 Viewers — Fake Traffic"
        case .filters: "🎭 Filters — AR Effects"
        case .gifts: "🎁 Gifts — Virtual Economy"
        }
    }

    private var contentHeight: CGFloat {
        if isExpanded {
            return selectedTool == .tone ? 420 : 560
        }

        switch selectedTool {
        case .tone:
            return 280
        case .vibe:
            return 342
        case .viewers:
            return 210
        case .filters:
            return 300
        case .gifts:
            return 520
        }
    }

    private var promptBar: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("CUSTOM COMMENT")
                .font(.system(size: 12, weight: .black))
                .foregroundStyle(.white.opacity(0.48))
            HStack(spacing: 10) {
                TextField("Type a comment...", text: $quickPrompt)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.white)
                    .disableAutocorrection(true)
                    .padding(.horizontal, 16)
                    .frame(height: 52)
                    .background(.white.opacity(0.10), in: Capsule())
                    .overlay(Capsule().stroke(.white.opacity(0.14)))
                    .contentShape(Rectangle())

                Button {
                    if hasPromptText {
                        onSendPrompt()
                    }
                } label: {
                    Image(systemName: hasPromptText ? "paperplane.fill" : "plus")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 52, height: 52)
                        .background(Color.brandPurple, in: Circle())
                }
                .buttonStyle(.plain)
                .contentShape(Circle())
                .opacity(hasPromptText ? 1 : 0.82)
            }
        }
    }

    private var hasPromptText: Bool {
        !quickPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @ViewBuilder
    private var toolContent: some View {
        switch selectedTool {
        case .tone:
            VStack(alignment: .leading, spacing: 16) {
                Text("BARRAGE TOPICS")
                    .font(.system(size: 12, weight: .black))
                    .foregroundStyle(.white.opacity(0.48))
                FlowTags(items: toneTopicsData, selected: toneTopics) { topic in
                    toggle(topic, in: &toneTopics, allowsEmpty: false)
                }
                promptBar
            }
        case .vibe:
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("AUDIENCE MOOD")
                    Spacer()
                    Text("\(vibeMoods.count) active · choose one or more")
                }
                .font(.system(size: 12, weight: .black))
                .foregroundStyle(.white.opacity(0.48))

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
                    ForEach(vibeData, id: \.0) { item in
                        let active = vibeMoods.contains(item.0)
                        Button {
                            toggle(item.0, in: &vibeMoods, allowsEmpty: false)
                            audienceEnergy = active ? max(0.25, audienceEnergy - 0.08) : min(1, audienceEnergy + 0.08)
                        } label: {
                            VStack(alignment: .leading, spacing: 7) {
                                Text(item.1)
                                    .font(.system(size: 26))
                                Text(item.0)
                                    .font(.system(size: 14, weight: .black))
                                    .foregroundStyle(.white)
                                Text(item.2)
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.45))
                                    .lineLimit(2)
                                Spacer()
                                Text(active ? "Added" : "Add")
                                    .font(.system(size: 12, weight: .black))
                                    .foregroundStyle(active ? .white : .white.opacity(0.46))
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 30)
                                    .background(active ? Color.brandPurple.opacity(0.55) : .white.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
                            }
                            .padding(12)
                            .frame(height: 142)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16).stroke(active ? Color.brandPurple.opacity(0.70) : .white.opacity(0.12), lineWidth: 1.2))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        case .viewers:
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("BUY FAKE VIEWERS")
                    Spacer()
                    CoinIcon(size: 18)
                    Text("\(coins)")
                        .foregroundStyle(Color.gold)
                }
                .font(.system(size: 12, weight: .black))
                .foregroundStyle(.white.opacity(0.48))

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 2), spacing: 14) {
                    ForEach(viewerOptions, id: \.0) { option in
                        let canAfford = coins >= option.2
                        Button {
                            onBuyViewers(option.1, option.2)
                        } label: {
                            VStack(spacing: 8) {
                                Text(option.0)
                                    .font(.system(size: 20, weight: .black))
                                    .foregroundStyle(canAfford ? .white : .white.opacity(0.38))
                                HStack(spacing: 5) {
                                    CoinIcon(size: 15)
                                    Text("\(option.2)")
                                        .font(.system(size: 12, weight: .black))
                                }
                                .foregroundStyle(Color.gold)
                                .opacity(canAfford ? 1 : 0.42)
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 86)
                            .background(canAfford ? Color.brandPurple.opacity(0.18) : .white.opacity(0.04), in: RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16).stroke(canAfford ? Color.brandPurple.opacity(0.62) : .white.opacity(0.07)))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        case .filters:
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("AR FILTERS")
                    Spacer()
                    CoinIcon(size: 18)
                    Text("\(coins)")
                        .foregroundStyle(Color.gold)
                }
                .font(.system(size: 12, weight: .black))
                .foregroundStyle(.white.opacity(0.48))

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 3), spacing: 14) {
                    ForEach(filters, id: \.0) { filter in
                        let selected = selectedFilter == filter.0
                        Button {
                            selectedFilter = selected ? "None" : filter.0
                            beautyFilter = selected ? 0.0 : 0.62
                        } label: {
                            VStack(spacing: 8) {
                                Text(filter.1)
                                    .font(.system(size: 28))
                                Text(filter.0)
                                    .font(.system(size: 12, weight: .black))
                                    .foregroundStyle(.white)
                                    .multilineTextAlignment(.center)
                                    .lineLimit(2)
                                HStack(spacing: 4) {
                                    CoinIcon(size: 13)
                                    Text("\(filter.2)")
                                        .font(.system(size: 11, weight: .black))
                                }
                                .foregroundStyle(Color.gold)
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 116)
                            .background(.white.opacity(selected ? 0.13 : 0.07), in: RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? Color.brandPurple.opacity(0.76) : .white.opacity(0.12), lineWidth: 1.2))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        case .gifts:
            VStack(alignment: .leading, spacing: 14) {
                Toggle(isOn: $autoFakeDonations) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Auto Fake Donations")
                            .font(.system(size: 15, weight: .black))
                            .foregroundStyle(.white)
                        Text("Receive gifts automatically during stream")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.white.opacity(0.46))
                    }
                }
                .tint(Color.brandPurple)
                .padding(14)
                .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.12)))

                HStack {
                    Text("GIFT STORE")
                    Spacer()
                    CoinIcon(size: 18)
                    Text("\(coins)")
                        .foregroundStyle(Color.gold)
                }
                .font(.system(size: 12, weight: .black))
                .foregroundStyle(.white.opacity(0.48))

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 3), spacing: 14) {
                    ForEach(Array(giftAssets.prefix(12).enumerated()), id: \.offset) { index, asset in
                        let selected = selectedGiftIndexes.contains(index)
                        Button {
                            toggleGift(index)
                        } label: {
                            VStack(spacing: 9) {
                                ZStack(alignment: .topTrailing) {
                                    RoundedRectangle(cornerRadius: 14)
                                        .fill(.black.opacity(0.18))
                                        .frame(height: 78)
                                    if let url = asset.resourceURL {
                                        GiftMediaView(resourceURL: url, format: asset.format)
                                            .frame(width: 72, height: 72)
                                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                                    } else {
                                        FallbackGiftBurst(isActive: true)
                                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                                    }
                                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                                        .font(.system(size: 17, weight: .bold))
                                        .foregroundStyle(selected ? Color.green : .white.opacity(0.40))
                                        .padding(6)
                                }

                                Text(giftNames[safe: index] ?? "Gift")
                                    .font(.system(size: 12, weight: .black))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                HStack(spacing: 4) {
                                    CoinIcon(size: 13)
                                    Text("\(giftPrices[safe: index] ?? 1)")
                                        .font(.system(size: 11, weight: .black))
                                }
                                .foregroundStyle(Color.gold)
                            }
                            .padding(8)
                            .frame(maxWidth: .infinity)
                            .frame(height: 150)
                            .background(.white.opacity(selected ? 0.13 : 0.07), in: RoundedRectangle(cornerRadius: 18))
                            .overlay(RoundedRectangle(cornerRadius: 18).stroke(selected ? Color.brandPurple.opacity(0.78) : .white.opacity(0.12), lineWidth: 1.3))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func toggleGift(_ index: Int) {
        if selectedGiftIndexes.contains(index) {
            selectedGiftIndexes.removeAll { $0 == index }
        } else {
            selectedGiftIndexes.append(index)
        }
    }

    private func toggle(_ item: String, in values: inout [String], allowsEmpty: Bool) {
        if values.contains(item) {
            if allowsEmpty || values.count > 1 {
                values.removeAll { $0 == item }
            }
        } else {
            values.append(item)
        }
    }
}

private struct LivePanelSlider: View {
    let title: String
    @Binding var value: Double
    let icon: String

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.brandPurple)
                Text(title)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white.opacity(0.74))
                Spacer()
                Text("\(Int(value * 100))%")
                    .font(.system(size: 12, weight: .black))
                    .foregroundStyle(.white)
            }
            Slider(value: $value, in: 0...1, step: 0.01)
                .tint(Color.brandPurple)
        }
    }
}

private struct FlowTags: View {
    let items: [String]
    let selected: [String]
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(rows, id: \.self) { row in
                HStack(spacing: 8) {
                    ForEach(row, id: \.self) { item in
                        let active = selected.contains(item)
                        Button {
                            onTap(item)
                        } label: {
                            Text(item)
                                .font(.system(size: 14, weight: .black))
                                .foregroundStyle(active ? .white : .white.opacity(0.62))
                                .padding(.horizontal, 16)
                                .frame(height: 40)
                                .background(active ? Color.brandPurple : .white.opacity(0.10), in: Capsule())
                                .overlay(Capsule().stroke(active ? Color.brandPurple : .white.opacity(0.18)))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var rows: [[String]] {
        var output: [[String]] = []
        var current: [String] = []
        var currentWidth = 0

        for item in items {
            let width = max(76, item.count * 10 + 34)
            if currentWidth + width > 330, !current.isEmpty {
                output.append(current)
                current = [item]
                currentWidth = width
            } else {
                current.append(item)
                currentWidth += width
            }
        }

        if !current.isEmpty {
            output.append(current)
        }

        return output
    }
}

private struct StatChip: View {
    let icon: String
    let value: String
    let title: String

    var body: some View {
        VStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Color.brandPurple)
            Text(value)
                .font(.system(size: 12, weight: .black))
                .foregroundStyle(.white)
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.white.opacity(0.42))
        }
        .frame(maxWidth: .infinity)
        .frame(height: 70)
        .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.09)))
    }
}

private struct ExitStreamConfirmView: View {
    let onCancel: () -> Void
    let onEnd: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.76).ignoresSafeArea()

            VStack(spacing: 15) {
                Text("📡")
                    .font(.system(size: 42))
                Text("End your stream?")
                    .font(.system(size: 21, weight: .bold))
                    .foregroundStyle(.white)
                Text("Your viewers will lose connection. This cannot be undone.")
                    .font(.system(size: 14))
                    .foregroundStyle(.white.opacity(0.55))
                    .multilineTextAlignment(.center)

                HStack(spacing: 12) {
                    Button("Keep Streaming", action: onCancel)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))

                    Button("End Stream", action: onEnd)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(LinearGradient(colors: [.red, Color(red: 0.74, green: 0, blue: 0)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 16))
                }
                .padding(.top, 4)
            }
            .padding(24)
            .frame(maxWidth: 330)
            .background(Color(red: 0.08, green: 0.09, blue: 0.13).opacity(0.98), in: RoundedRectangle(cornerRadius: 28))
            .overlay(RoundedRectangle(cornerRadius: 28).stroke(.white.opacity(0.12)))
        }
    }
}

private struct PopularityBadge: View {
    let value: Int

    var body: some View {
        HStack(spacing: 7) {
            ZStack {
                Circle()
                    .fill(.white.opacity(0.18))
                Image(systemName: "person.2.fill")
                    .font(.system(size: 12, weight: .black))
                    .foregroundStyle(.white)
            }
            .frame(width: 24, height: 24)

            Text(formattedValue)
                .font(.system(size: 15, weight: .black))
                .foregroundStyle(.white)
                .contentTransition(.numericText())

            Text("watching")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.white.opacity(0.72))
        }
        .padding(.leading, 5)
        .padding(.trailing, 12)
        .frame(height: 34)
        .background(LinearGradient(colors: [Color.hotPink.opacity(0.95), Color.brandPurple.opacity(0.92), Color.brandOrange.opacity(0.88)], startPoint: .leading, endPoint: .trailing), in: Capsule())
        .overlay(Capsule().stroke(.white.opacity(0.22)))
        .shadow(color: Color.hotPink.opacity(0.22), radius: 14)
    }

    private var formattedValue: String {
        if value >= 10000 {
            return String(format: "%.1fK", Double(value) / 1000.0)
        }
        return "\(value)"
    }
}

private struct GiftEffectView: View {
    let gift: ActiveGiftEffect
    @State private var animate = false

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Group {
                    if let resourceURL = gift.asset.resourceURL {
                        GiftMediaView(resourceURL: resourceURL, format: gift.asset.format)
                            .frame(width: proxy.size.width, height: proxy.size.height)
                    } else {
                        EmptyView()
                    }
                }
                .opacity(animate ? 1 : 0)
                .scaleEffect(animate ? 1 : 0.92)
                .shadow(color: .black.opacity(0.24), radius: 18)

                VStack {
                    Spacer()
                    Text("\(gift.senderName) sent support")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .frame(height: 36)
                        .background(.black.opacity(0.56), in: Capsule())
                        .overlay(Capsule().stroke(.white.opacity(0.16)))
                        .padding(.bottom, max(130, proxy.size.height * 0.14))
                        .opacity(animate ? 1 : 0)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.spring(response: 0.42, dampingFraction: 0.76)) {
                animate = true
            }
        }
    }
}

private struct GiftMediaView: View {
    let resourceURL: URL
    let format: GiftAnimationFormat

    var body: some View {
#if os(iOS)
        switch format {
        case .webp:
            WebPGiftView(resourceURL: resourceURL)
        case .png, .svga:
            if let image = UIImage(contentsOfFile: resourceURL.path) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                FallbackGiftBurst(isActive: true)
            }
        }
#else
        FallbackGiftBurst(isActive: true)
#endif
    }
}

#if os(iOS)
private struct WebPGiftView: UIViewRepresentable {
    let resourceURL: URL

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.isUserInteractionEnabled = false
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.lastURL != resourceURL else { return }
        context.coordinator.lastURL = resourceURL
        guard let data = try? Data(contentsOf: resourceURL) else { return }
        let base64 = data.base64EncodedString()
        let html = """
        <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
        html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
        img { width: 100vw; height: 100vh; object-fit: contain; }
        </style>
        </head>
        <body><img src="data:image/webp;base64,\(base64)"></body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: resourceURL.deletingLastPathComponent())
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator {
        var lastURL: URL?
    }
}
#endif

private struct FallbackGiftBurst: View {
    let isActive: Bool

    private let symbols = ["✦", "●", "◆", "✧", "●", "✦", "◆", "✧", "❤", "✦", "●", "◆"]

    var body: some View {
        GeometryReader { proxy in
            let longSide = max(proxy.size.width, proxy.size.height)

            ZStack {
                ForEach(Array(symbols.enumerated()), id: \.offset) { index, symbol in
                    Text(symbol)
                        .font(.system(size: index.isMultiple(of: 2) ? 30 : 21, weight: .bold))
                        .foregroundStyle(index.isMultiple(of: 3) ? Color.gold : (index.isMultiple(of: 2) ? Color.hotPink : Color.brandPurple))
                        .offset(y: isActive ? -longSide * 0.32 : -longSide * 0.08)
                        .rotationEffect(.degrees(Double(index) * 30))
                        .opacity(isActive ? 0.95 : 0)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .animation(.easeOut(duration: 0.9), value: isActive)
    }
}

#if os(iOS)
private struct CameraPreview: UIViewRepresentable {
    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.configure()
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        private let session = AVCaptureSession()
        private var isConfigured = false

        override class var layerClass: AnyClass {
            AVCaptureVideoPreviewLayer.self
        }

        func configure() {
            guard !isConfigured else { return }
            guard let previewLayer = layer as? AVCaptureVideoPreviewLayer else { return }
            isConfigured = true

            previewLayer.videoGravity = .resizeAspectFill
            previewLayer.session = session

            DispatchQueue.global(qos: .userInitiated).async { [session] in
                session.beginConfiguration()
                session.sessionPreset = .medium

                if
                    let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
                    let input = try? AVCaptureDeviceInput(device: device),
                    session.canAddInput(input)
                {
                    session.addInput(input)
                }

                session.commitConfiguration()

                if !session.isRunning {
                    session.startRunning()
                }
            }
        }

        deinit {
            if session.isRunning {
                session.stopRunning()
            }
        }
    }
}
#else
private struct CameraPreview: View {
    var body: some View {
        LinearGradient(colors: [.brandPurple.opacity(0.36), .black.opacity(0.94), .black], startPoint: .top, endPoint: .bottom)
    }
}
#endif

private struct PaywallBanner: View {
    let listener: Listener
    let onClose: () -> Void
    let onUpgrade: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            Button(action: onUpgrade) {
                HStack(spacing: 14) {
                    RemoteImage(urlString: listener.imageURL)
                        .frame(width: 56, height: 56)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(.white.opacity(0.20)))

                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(listener.name) is typing a deep, heartfelt response...")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.leading)
                        HStack(spacing: 5) {
                            Circle().fill(.white.opacity(0.42)).frame(width: 7, height: 7)
                            Circle().fill(.white.opacity(0.42)).frame(width: 7, height: 7)
                            Circle().fill(.white.opacity(0.42)).frame(width: 7, height: 7)
                        }
                    }

                    Spacer(minLength: 4)

                    Label("PRO", systemImage: "lock.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .frame(height: 34)
                        .background(LinearGradient(colors: [.gold, .orange], startPoint: .leading, endPoint: .trailing), in: Capsule())
                }
                .padding(16)
                .padding(.top, 10)
                .background(LinearGradient(colors: [.black.opacity(0.82), .black.opacity(0.72)], startPoint: .leading, endPoint: .trailing), in: RoundedRectangle(cornerRadius: 26))
                .overlay(RoundedRectangle(cornerRadius: 26).stroke(.white.opacity(0.22)))
                .shadow(color: .black.opacity(0.40), radius: 24)
            }
            .buttonStyle(.plain)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .black))
                    .foregroundStyle(.white.opacity(0.86))
                    .frame(width: 42, height: 42)
                    .background(.black.opacity(0.58), in: Circle())
                    .overlay(Circle().stroke(.white.opacity(0.24)))
            }
            .buttonStyle(.plain)
            .contentShape(Circle())
            .padding(.leading, -6)
            .padding(.top, -10)
            .zIndex(5)
        }
    }
}

private struct RemoteImage: View {
    let urlString: String

    var body: some View {
        CachedRemoteImageView(url: displayURL)
        .clipped()
    }

    private var displayURL: URL? {
        guard var components = URLComponents(string: urlString) else {
            return URL(string: urlString)
        }

        if components.host?.contains("images.unsplash.com") == true {
            var queryItems = components.queryItems ?? []
            upsertQueryItem("w", value: "240", in: &queryItems)
            upsertQueryItem("h", value: "240", in: &queryItems)
            upsertQueryItem("fit", value: "crop", in: &queryItems)
            upsertQueryItem("crop", value: "faces", in: &queryItems)
            components.queryItems = queryItems
        }

        return components.url
    }

    private func upsertQueryItem(_ name: String, value: String, in queryItems: inout [URLQueryItem]) {
        if let index = queryItems.firstIndex(where: { $0.name == name }) {
            queryItems[index] = URLQueryItem(name: name, value: value)
        } else {
            queryItems.append(URLQueryItem(name: name, value: value))
        }
    }
}

#if os(iOS)
private struct CachedRemoteImageView: View {
    let url: URL?
    @State private var image: UIImage?
    @State private var didFail = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if didFail {
                remoteImageFallback
            } else {
                remoteImagePlaceholder
            }
        }
        .task(id: url) {
            await load()
        }
    }

    @MainActor
    private func load() async {
        didFail = false
        guard let url else {
            image = nil
            didFail = true
            return
        }

        if let cached = RemoteImageCache.image(for: url) {
            image = cached
            return
        }

        do {
            let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 12)
            let (data, _) = try await URLSession.shared.data(for: request)
            guard let loaded = UIImage(data: data) else {
                didFail = true
                return
            }
            RemoteImageCache.set(loaded, for: url)
            image = loaded
        } catch {
            didFail = true
        }
    }
}

private enum RemoteImageCache {
    private static let cache = NSCache<NSURL, UIImage>()
    private static var inFlight = Set<URL>()

    static func image(for url: URL) -> UIImage? {
        cache.object(forKey: url as NSURL)
    }

    static func set(_ image: UIImage, for url: URL) {
        cache.setObject(image, forKey: url as NSURL)
    }

    static func prefetch(urlStrings: [String]) {
        let urls = Set(urlStrings.compactMap { URL(string: $0) })
        for url in urls where image(for: url) == nil && !inFlight.contains(url) {
            inFlight.insert(url)
            Task.detached {
                defer {
                    Task { @MainActor in
                        inFlight.remove(url)
                    }
                }
                do {
                    let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 12)
                    let (data, _) = try await URLSession.shared.data(for: request)
                    if let image = UIImage(data: data) {
                        await MainActor.run {
                            set(image, for: url)
                        }
                    }
                } catch {}
            }
        }
    }
}
#else
private struct CachedRemoteImageView: View {
    let url: URL?

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .scaledToFill()
            case .failure:
                remoteImageFallback
            default:
                remoteImagePlaceholder
            }
        }
    }
}
#endif

private var remoteImageFallback: some View {
    ZStack {
        LinearGradient(colors: [.brandPurple.opacity(0.55), .brandOrange.opacity(0.45)], startPoint: .topLeading, endPoint: .bottomTrailing)
        Image(systemName: "person.fill")
            .font(.system(size: 28, weight: .semibold))
            .foregroundStyle(.white.opacity(0.72))
    }
}

private var remoteImagePlaceholder: some View {
    ZStack {
        LinearGradient(colors: [.white.opacity(0.12), .white.opacity(0.05)], startPoint: .topLeading, endPoint: .bottomTrailing)
        ProgressView()
            .tint(.white.opacity(0.65))
    }
}

private struct LoopingVideoBackground: View {
    let resourceName: String
    let resourceExtension: String

    var body: some View {
#if os(iOS)
        if let url = Bundle.main.url(forResource: resourceName, withExtension: resourceExtension, subdirectory: "Media")
            ?? Bundle.main.url(forResource: resourceName, withExtension: resourceExtension) {
            LoopingVideoPlayer(url: url)
        } else {
            LinearGradient(colors: [.brandPurple.opacity(0.34), .brandOrange.opacity(0.20), .clear], startPoint: .top, endPoint: .bottom)
        }
#else
        LinearGradient(colors: [.brandPurple.opacity(0.34), .brandOrange.opacity(0.20), .clear], startPoint: .top, endPoint: .bottom)
#endif
    }
}

#if os(iOS)
private struct LoopingVideoPlayer: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> LoopingVideoUIView {
        let view = LoopingVideoUIView()
        view.configure(url: url)
        return view
    }

    func updateUIView(_ uiView: LoopingVideoUIView, context: Context) {
        uiView.configure(url: url)
    }
}

private final class LoopingVideoUIView: UIView {
    private let player = AVPlayer()
    private let playerLayer = AVPlayerLayer()
    private var currentURL: URL?
    private var endObserver: NSObjectProtocol?

    override init(frame: CGRect) {
        super.init(frame: frame)
        playerLayer.videoGravity = .resizeAspectFill
        layer.addSublayer(playerLayer)
        playerLayer.player = player
        player.isMuted = true
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        playerLayer.frame = bounds
    }

    func configure(url: URL) {
        guard currentURL != url else { return }
        currentURL = url
        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)

        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            self?.player.seek(to: .zero)
            self?.player.play()
        }

        player.play()
    }

    deinit {
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        player.pause()
    }
}
#endif

private struct PremiumCheckoutView: View {
    let onClose: () -> Void
    let onSubscribe: () -> Void
    let onTerms: () -> Void
    let onPrivacy: () -> Void
    @State private var restoreMessage: String?
    @State private var selectedPlan = "weekly"

    private let benefits = [
        ("person.2.fill", "20K+ live room viewers"),
        ("checkmark.shield", "Get verified badge"),
        ("bubble.left.and.bubble.right", "Real-time AI audience interaction"),
        ("sparkles", "Premium effects & virtual gifts"),
        ("eye", "AI fans react to your appearance"),
        ("mic", "AI fans react to your voice")
    ]

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ZStack {
                LoopingVideoBackground(resourceName: "PremiumFriendsLoop", resourceExtension: "mp4")
                    .ignoresSafeArea()
                LinearGradient(colors: [.black.opacity(0.18), .black.opacity(0.42), .black.opacity(0.96)], startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea()
                Color.black.opacity(0.18).ignoresSafeArea()
            }

            VStack(spacing: 0) {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 58, height: 58)
                        .background(.white.opacity(0.18), in: Circle())
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
                .padding(.leading, 20)
                .zIndex(20)

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 18) {
                        VStack(spacing: 4) {
                            Text("Unlimited Access")
                                .font(.system(size: 34, weight: .black))
                                .foregroundStyle(.white)
                                .multilineTextAlignment(.center)
                        }

                        VStack(alignment: .leading, spacing: 14) {
                            ForEach(benefits, id: \.1) { benefit in
                                HStack(spacing: 14) {
                                    Image(systemName: benefit.0)
                                        .font(.system(size: 15, weight: .bold))
                                        .foregroundStyle(.white)
                                        .frame(width: 30, height: 30)
                                        .background(Color.brandPurple.opacity(0.70), in: Circle())
                                    Text(benefit.1)
                                        .font(.system(size: 15, weight: .bold))
                                        .foregroundStyle(.white)
                                    Spacer()
                                }
                            }
                        }
                        .padding(.top, 2)

                        VStack(spacing: 12) {
                            SubscriptionPlanCard(
                                title: "3-Day Free Trial",
                                price: "US$9.99",
                                detail: "per week",
                                badge: nil,
                                isSelected: selectedPlan == "weekly"
                            ) {
                                selectedPlan = "weekly"
                            }

                            SubscriptionPlanCard(
                                title: nil,
                                price: "US$59.99",
                                detail: "per year · US$1.15/week",
                                badge: "Save 88%",
                                isSelected: selectedPlan == "yearly"
                            ) {
                                selectedPlan = "yearly"
                            }
                        }

                        Label("No payment today", systemImage: "checkmark.circle.fill")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white.opacity(0.78))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(Color.green, .white.opacity(0.78))

                        Button(action: onSubscribe) {
                            Text("Start My 3-Day Free Trial")
                                .font(.system(size: 19, weight: .black))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .frame(height: 70)
                                .background(LinearGradient(colors: [Color(red: 0.34, green: 0.52, blue: 0.94), Color.brandPurpleDark], startPoint: .leading, endPoint: .trailing), in: RoundedRectangle(cornerRadius: 18))
                                .shadow(color: Color.brandPurple.opacity(0.32), radius: 24)
                        }

                        if let restoreMessage {
                            Text(restoreMessage)
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(.white.opacity(0.72))
                        }

                        HStack(spacing: 18) {
                            Button("Restore Purchase") {
                                restoreMessage = "No active purchases found."
                            }
                            Button("Privacy Policy", action: onPrivacy)
                            Button("Terms of Use", action: onTerms)
                        }
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white.opacity(0.42))
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                }
            }
        }
    }
}

private struct SubscriptionPlanCard: View {
    let title: String?
    let price: String
    let detail: String
    let badge: String?
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                Circle()
                    .stroke(isSelected ? Color.brandPurple : .white.opacity(0.38), lineWidth: 2)
                    .frame(width: 24, height: 24)
                    .overlay {
                        if isSelected {
                            Circle()
                                .fill(Color.brandPurple)
                                .frame(width: 12, height: 12)
                        }
                    }

                VStack(alignment: .leading, spacing: 4) {
                    if let title {
                        Text(title)
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.white.opacity(0.68))
                    }
                    Text(price)
                        .font(.system(size: 22, weight: .black))
                        .foregroundStyle(.white)
                    Text(detail)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white.opacity(0.46))
                }

                Spacer()

                if let badge {
                    Text(badge)
                        .font(.system(size: 13, weight: .black))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .frame(height: 34)
                        .background(Color.green, in: Capsule())
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity)
            .frame(height: 96)
            .background(.white.opacity(isSelected ? 0.16 : 0.07), in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(isSelected ? .white.opacity(0.86) : .white.opacity(0.16), lineWidth: isSelected ? 2 : 1))
        }
        .buttonStyle(.plain)
    }
}

private enum LegalKind {
    case terms
    case privacy

    var title: String {
        switch self {
        case .terms: "Terms of Use"
        case .privacy: "Privacy Policy"
        }
    }

    var sections: [(String, String)] {
        switch self {
        case .terms:
            [
                ("AI Support", "SquadLive is an AI-powered emotional support prototype. It is not medical care, crisis care, therapy, or a substitute for professional advice."),
                ("Subscriptions", "Premium features shown in this prototype are illustrative. Real purchases require StoreKit integration before release."),
                ("Use", "Use the app respectfully and only for personal support sessions.")
            ]
        case .privacy:
            [
                ("Private Sessions", "The prototype is designed around an AI-only experience. No human audience is connected to your live session."),
                ("Permissions", "Camera, microphone, and speech recognition permissions are requested only to support the simulated live session experience."),
                ("Data", "Profile selections are currently kept in app memory for the active session unless persistence is added later.")
            ]
        }
    }
}

private struct LegalTextView: View {
    let kind: LegalKind
    let onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: kind.title, onBack: onBack)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(kind.sections, id: \.0) { section in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(section.0)
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(.white)
                            Text(section.1)
                                .font(.system(size: 14))
                                .foregroundStyle(.white.opacity(0.66))
                                .lineSpacing(3)
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
                        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.10)))
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 18)
                .padding(.bottom, 30)
            }
        }
    }
}

private struct PageHeader: View {
    let title: String
    let onBack: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.white.opacity(0.10), in: Circle())
            }

            Text(title)
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.8)

            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 10)
    }
}

private struct FormField: View {
    let title: String
    @Binding var text: String
    let placeholder: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.58))
            TextField(placeholder, text: $text)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .frame(height: 52)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.12)))
        }
    }
}

private struct OptionPicker: View {
    let title: String
    let options: [String]
    @Binding var selection: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.58))

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(options, id: \.self) { option in
                        Button {
                            selection = option
                        } label: {
                            Text(label(for: option))
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(selection == option ? .white : .white.opacity(0.68))
                                .padding(.horizontal, 14)
                                .frame(height: 38)
                                .background(selection == option ? Color.brandPurple : .white.opacity(0.06), in: Capsule())
                                .overlay(Capsule().stroke(selection == option ? Color.brandPurple : .white.opacity(0.12)))
                        }
                    }
                }
            }
        }
    }

    private func label(for value: String) -> String {
        switch value {
        case "he": "He/Him"
        case "she": "She/Her"
        case "they": "They/Them"
        case "under18": "Under 18"
        case "work": "Work Stress"
        case "relationship": "Relationship"
        case "lonely": "Lonely"
        case "hype": "Hype Squad"
        default: value
        }
    }
}

private struct SettingToggleRow: View {
    let icon: String
    let title: String
    let description: String
    @Binding var isOn: Bool

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.brandPurple)
                .frame(width: 44, height: 44)
                .background(Color.brandPurple.opacity(0.18), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                Text(description)
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.58))
                    .lineLimit(2)
            }

            Spacer()

            Toggle("", isOn: $isOn)
                .labelsHidden()
                .tint(Color.brandPurple)
        }
        .padding(16)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.10)))
    }
}

private struct InfoRow: View {
    let icon: String
    let title: String
    let description: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Color.brandPurple)
                .frame(width: 48, height: 48)
                .background(Color.brandPurple.opacity(0.20), in: Circle())

            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.white)
                Text(description)
                    .font(.system(size: 14))
                    .foregroundStyle(.white.opacity(0.62))
                    .lineSpacing(3)
            }
        }
        .padding(18)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.10)))
    }
}

private struct MenuRow: View {
    let icon: String
    let iconColor: Color
    let title: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(iconColor)
                .frame(width: 42, height: 42)
                .background(iconColor.opacity(0.18), in: Circle())
            Text(title)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(.white.opacity(0.42))
        }
        .padding(14)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.10)))
    }
}

private struct PrimaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 60)
                .background(LinearGradient(colors: [.brandPurple, .brandPurpleDark], startPoint: .leading, endPoint: .trailing), in: Capsule())
                .shadow(color: .brandPurple.opacity(0.40), radius: 18)
        }
    }
}

private struct FlowLayout<Content: View>: View {
    let items: [String]
    let content: (String) -> Content

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                ForEach(items.prefix(2), id: \.self, content: content)
            }
            HStack(spacing: 8) {
                ForEach(items.dropFirst(2), id: \.self, content: content)
            }
        }
    }
}

private extension Color {
    static let appBackground = Color(red: 0.043, green: 0.055, blue: 0.078)
    static let brandPurple = Color(red: 0.616, green: 0.518, blue: 1.0)
    static let brandPurpleDark = Color(red: 0.545, green: 0.435, blue: 1.0)
    static let brandOrange = Color(red: 1.0, green: 0.498, blue: 0.314)
    static let hotPink = Color(red: 1.0, green: 0.078, blue: 0.576)
    static let gold = Color(red: 1.0, green: 0.843, blue: 0.0)
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private struct ContentViewPreview: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
