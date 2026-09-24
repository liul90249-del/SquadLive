import SwiftUI
import Foundation
import AVFoundation
import Speech
import Combine
import NaturalLanguage
import StoreKit
#if os(iOS)
import UIKit
import Vision
import ImageIO
import PhotosUI
import Photos
import ReplayKit
import WebKit
import UserNotifications
import AuthenticationServices
#endif

private enum AppScreen {
    case splash
    case onboarding
    case avatars
    case permissions
    case lobby
    case editProfile
    case settings
    case allListeners
    case moodCheckIn
    case sessionSettings
    case live
    case liveSummary
    case coinStore
    case checkout
}

private enum SquadLiveLegalLinks {
    static let privacy = URL(string: "https://squadlive.onrender.com/privacy")!
    static let terms = URL(string: "https://squadlive.onrender.com/terms")!
}

private enum StoreProductID {
    static let weekly = "com.liuzhigang.squadlive.pro.weekly"
    static let annual = "com.liuzhigang.squadlive.pro.annual"
    static let coin330 = "com.liuzhigang.squadlive.coins.330"
    static let coin420 = "com.liuzhigang.squadlive.coins.420"
    static let coin525 = "com.liuzhigang.squadlive.coins.525"
    static let coin740 = "com.liuzhigang.squadlive.coins.740"
    static let coin1450 = "com.liuzhigang.squadlive.coins.1450"
    static let coin1800 = "com.liuzhigang.squadlive.coins.1800"

    static let subscriptions = [weekly, annual]
    static let coinAmounts = [
        coin330: 330,
        coin420: 420,
        coin525: 525,
        coin740: 740,
        coin1450: 1_450,
        coin1800: 1_800
    ]
    static let all = subscriptions + Array(coinAmounts.keys)
}

private struct StoreCoinGrant: Identifiable, Equatable {
    let id: UInt64
    let productID: String
    let coins: Int
    let balance: Int
}

@MainActor
private final class StorePurchaseManager: ObservableObject {
    @Published private(set) var products: [String: Product] = [:]
    @Published private(set) var isPremium = false
    @Published private(set) var didLoadEntitlements = false
    @Published private(set) var activeSubscriptionProductID: String?
    @Published private(set) var subscriptionPurchaseDate: Date?
    @Published private(set) var subscriptionExpirationDate: Date?
    @Published private(set) var subscriptionGracePeriodExpirationDate: Date?
    @Published private(set) var subscriptionWillAutoRenew: Bool?
    @Published private(set) var subscriptionStatusText = "Inactive"
    @Published private(set) var purchasingProductID: String?
    @Published private(set) var coinGrant: StoreCoinGrant?
    @Published private(set) var statusMessage: String?

    private var updatesTask: Task<Void, Never>?
    private var unfinishedRetryTask: Task<Void, Never>?
    private var hasStarted = false
    private var queuedCoinGrants: [StoreCoinGrant] = []
    private var pendingCoinTransactions: [UInt64: StoreKit.Transaction] = [:]
    private var deliveringCoinTransactionIDs: Set<UInt64> = []
    private var coinGrantHandler: ((StoreCoinGrant) -> Void)?
    private var processedTransactionIDs: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: "squadlive.processedCoinTransactions") ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: "squadlive.processedCoinTransactions") }
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        await SquadLivePartnerAttributionClient.bootstrap()
        updatesTask = Task { [weak self] in
            for await result in StoreKit.Transaction.updates {
                guard let self else { return }
                await self.handle(result)
            }
        }
        await loadProducts()
        await recoverUnfinishedTransactions()
        await refreshEntitlements()
    }

    func product(for id: String) -> Product? {
        products[id]
    }

    func setCoinGrantHandler(_ handler: @escaping (StoreCoinGrant) -> Void) {
        coinGrantHandler = handler
        deliverCurrentCoinGrantIfPossible()
    }

    func purchase(productID: String) async -> Bool {
        let purchaseType = StoreProductID.coinAmounts[productID] == nil ? "subscription" : "coins"
        SquadLiveAnalytics.log("purchase_started", parameters: [
            "product_id": productID,
            "purchase_type": purchaseType
        ])
        if products[productID] == nil {
            await loadProducts()
        }
        guard let product = products[productID] else {
            statusMessage = "This product is not available from the App Store yet."
            SquadLiveAnalytics.log("purchase_failed", parameters: [
                "product_id": productID,
                "purchase_type": purchaseType,
                "reason": "product_unavailable"
            ])
            return false
        }

        purchasingProductID = productID
        statusMessage = nil
        defer { purchasingProductID = nil }

        do {
            let result: Product.PurchaseResult
            if let accountToken = SquadLiveDeviceIdentity.purchaseAccountToken {
                result = try await product.purchase(options: [.appAccountToken(accountToken)])
            } else {
                result = try await product.purchase()
            }
            switch result {
            case .success(let verification):
                guard case .verified(let transaction) = verification else {
                    statusMessage = "The App Store could not verify this purchase."
                    SquadLiveAnalytics.log("purchase_failed", parameters: [
                        "product_id": productID,
                        "purchase_type": purchaseType,
                        "reason": "verification_failed"
                    ])
                    return false
                }
                guard await processVerified(transaction, signedTransaction: verification.jwsRepresentation) else {
                    SquadLiveAnalytics.log("purchase_failed", parameters: [
                        "product_id": productID,
                        "purchase_type": purchaseType,
                        "reason": "server_verification_failed"
                    ])
                    return false
                }
                statusMessage = StoreProductID.coinAmounts[productID] == nil ? "Subscription activated." : "Purchase completed."
                SquadLiveAnalytics.log("purchase_completed", parameters: [
                    "product_id": productID,
                    "purchase_type": purchaseType
                ])
                return true
            case .pending:
                statusMessage = "Purchase is pending approval."
                SquadLiveAnalytics.log("purchase_pending", parameters: [
                    "product_id": productID,
                    "purchase_type": purchaseType
                ])
                return false
            case .userCancelled:
                statusMessage = nil
                SquadLiveAnalytics.log("purchase_cancelled", parameters: [
                    "product_id": productID,
                    "purchase_type": purchaseType
                ])
                return false
            @unknown default:
                statusMessage = "The purchase could not be completed."
                return false
            }
        } catch {
            statusMessage = "Unable to connect to the App Store. Please try again."
            SquadLiveAnalytics.log("purchase_failed", parameters: [
                "product_id": productID,
                "purchase_type": purchaseType,
                "reason": "store_error"
            ])
            return false
        }
    }

    func restorePurchases() async -> Bool {
        do {
            try await AppStore.sync()
            await recoverUnfinishedTransactions()
            await refreshEntitlements()
            statusMessage = isPremium ? "Your subscription has been restored." : "No active subscription was found."
            SquadLiveAnalytics.log("purchase_restored", parameters: ["has_subscription": isPremium ? 1 : 0])
            return isPremium
        } catch {
            statusMessage = "Restore failed. Please try again."
            SquadLiveAnalytics.log("restore_failed")
            return false
        }
    }

    func acknowledgeCoinGrant(_ grant: StoreCoinGrant) async {
        var processed = processedTransactionIDs
        processed.insert(String(grant.id))
        processedTransactionIDs = processed
        if let transaction = pendingCoinTransactions.removeValue(forKey: grant.id) {
            await transaction.finish()
        }
        if coinGrant?.id == grant.id {
            coinGrant = nil
            deliveringCoinTransactionIDs.remove(grant.id)
            publishNextCoinGrant()
        }
    }

    private func loadProducts() async {
        do {
            let loadedProducts = try await Product.products(for: StoreProductID.all)
            products = Dictionary(uniqueKeysWithValues: loadedProducts.map { ($0.id, $0) })
            if loadedProducts.isEmpty {
                statusMessage = "App Store products are still being prepared."
            }
        } catch {
            statusMessage = "Unable to load App Store products."
        }
    }

    private func refreshEntitlements() async {
        var activeSubscription: StoreKit.Transaction?
        if #available(iOS 18.4, macOS 15.4, tvOS 18.4, watchOS 11.4, *) {
            for productID in StoreProductID.subscriptions {
                for await result in StoreKit.Transaction.currentEntitlements(for: productID) {
                    guard case .verified(let transaction) = result else { continue }
                    guard isActiveSubscription(transaction) else { continue }
                    if let currentExpiration = activeSubscription?.expirationDate,
                       let candidateExpiration = transaction.expirationDate,
                       currentExpiration >= candidateExpiration { continue }
                    activeSubscription = transaction
                }
            }
        } else {
            for await result in StoreKit.Transaction.currentEntitlements {
                guard case .verified(let transaction) = result else { continue }
                guard isActiveSubscription(transaction) else { continue }
                if let currentExpiration = activeSubscription?.expirationDate,
                   let candidateExpiration = transaction.expirationDate,
                   currentExpiration >= candidateExpiration { continue }
                activeSubscription = transaction
            }
        }

        if let activeSubscription {
            applySubscriptionDetails(from: activeSubscription)
            await refreshSubscriptionStatus(for: activeSubscription.productID)
        } else {
            clearSubscriptionDetails()
        }
        didLoadEntitlements = true
    }

    private func recoverUnfinishedTransactions() async {
        for await result in StoreKit.Transaction.unfinished {
            await handle(result)
        }
    }

    private func handle(_ result: VerificationResult<StoreKit.Transaction>) async {
        guard case .verified(let transaction) = result else { return }
        _ = await processVerified(transaction, signedTransaction: result.jwsRepresentation)
    }

    private func processVerified(_ transaction: StoreKit.Transaction, signedTransaction: String?) async -> Bool {
        if let amount = StoreProductID.coinAmounts[transaction.productID] {
            let transactionKey = String(transaction.id)
            guard !processedTransactionIDs.contains(transactionKey), pendingCoinTransactions[transaction.id] == nil else {
                await transaction.finish()
                return true
            }
            guard let signedTransaction,
                  let claim = await StoreBackendClient.claimCoins(signedTransaction: signedTransaction) else {
                statusMessage = "Purchase received. Waiting for secure server verification."
                SquadLiveAnalytics.log("coin_claim_failed", parameters: ["product_id": transaction.productID, "reason": "server_unavailable"])
                scheduleUnfinishedTransactionRetry()
                return false
            }
            guard claim.creditedCoins == amount else {
                statusMessage = "The purchased coin amount could not be verified."
                SquadLiveAnalytics.log("coin_claim_failed", parameters: ["product_id": transaction.productID, "reason": "amount_mismatch"])
                return false
            }
            let grant = StoreCoinGrant(
                id: transaction.id,
                productID: transaction.productID,
                coins: claim.creditedCoins,
                balance: claim.balance
            )
            pendingCoinTransactions[transaction.id] = transaction
            queuedCoinGrants.append(grant)
            publishNextCoinGrant()
            SquadLiveAnalytics.log("coin_claimed", parameters: [
                "product_id": transaction.productID,
                "coins": claim.creditedCoins,
                "balance": claim.balance
            ])
            return true
        }

        if StoreProductID.subscriptions.contains(transaction.productID) {
            if isActiveSubscription(transaction) {
                applySubscriptionDetails(from: transaction)
                await refreshSubscriptionStatus(for: transaction.productID)
            } else {
                clearSubscriptionDetails()
            }
            didLoadEntitlements = true
            guard transaction.appAccountToken == SquadLiveDeviceIdentity.purchaseAccountToken,
                  let signedTransaction else {
                await transaction.finish()
                return true
            }
            guard await StoreBackendClient.claimSubscription(signedTransaction: signedTransaction) else {
                statusMessage = "Subscription active. Secure server sync will retry automatically."
                SquadLiveAnalytics.log("subscription_sync_failed", parameters: ["product_id": transaction.productID])
                scheduleUnfinishedTransactionRetry()
                return true
            }
            SquadLiveAnalytics.log("subscription_synced", parameters: ["product_id": transaction.productID])
        }
        await transaction.finish()
        return true
    }

    private func isActiveSubscription(_ transaction: StoreKit.Transaction) -> Bool {
        StoreProductID.subscriptions.contains(transaction.productID)
            && transaction.revocationDate == nil
            && !transaction.isUpgraded
    }

    private func applySubscriptionDetails(from transaction: StoreKit.Transaction) {
        isPremium = true
        activeSubscriptionProductID = transaction.productID
        subscriptionPurchaseDate = transaction.purchaseDate
        subscriptionExpirationDate = transaction.expirationDate
    }

    private func clearSubscriptionDetails() {
        isPremium = false
        activeSubscriptionProductID = nil
        subscriptionPurchaseDate = nil
        subscriptionExpirationDate = nil
        subscriptionGracePeriodExpirationDate = nil
        subscriptionWillAutoRenew = nil
        subscriptionStatusText = "Inactive"
    }

    private func refreshSubscriptionStatus(for productID: String) async {
        guard let subscription = products[productID]?.subscription else {
            subscriptionStatusText = "Active"
            return
        }

        do {
            let statuses = try await subscription.status
            let status = statuses.first { status in
                guard case .verified(let transaction) = status.transaction else { return false }
                return transaction.productID == productID
            } ?? statuses.first
            guard let status else {
                subscriptionStatusText = "Active"
                return
            }

            if status.state == .inGracePeriod {
                subscriptionStatusText = "Billing Grace Period"
            } else if status.state == .inBillingRetryPeriod {
                subscriptionStatusText = "Billing Retry"
            } else if status.state == .revoked {
                clearSubscriptionDetails()
            } else if status.state == .expired {
                clearSubscriptionDetails()
            } else {
                subscriptionStatusText = "Active"
            }

            if case .verified(let renewalInfo) = status.renewalInfo {
                subscriptionWillAutoRenew = renewalInfo.willAutoRenew
                subscriptionGracePeriodExpirationDate = renewalInfo.gracePeriodExpirationDate
            }
        } catch {
            subscriptionStatusText = "Active"
        }
    }

    private func publishNextCoinGrant() {
        guard coinGrant == nil, !queuedCoinGrants.isEmpty else { return }
        coinGrant = queuedCoinGrants.removeFirst()
        deliverCurrentCoinGrantIfPossible()
    }

    private func deliverCurrentCoinGrantIfPossible() {
        guard let grant = coinGrant,
              let coinGrantHandler,
              deliveringCoinTransactionIDs.insert(grant.id).inserted else { return }
        coinGrantHandler(grant)
        Task { [weak self] in
            await self?.acknowledgeCoinGrant(grant)
        }
    }

    private func scheduleUnfinishedTransactionRetry() {
        guard unfinishedRetryTask == nil else { return }
        unfinishedRetryTask = Task { [weak self] in
            for delay in [3, 10, 30] {
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled, let self else { return }
                await self.recoverUnfinishedTransactions()
            }
            self?.unfinishedRetryTask = nil
        }
    }

    deinit {
        updatesTask?.cancel()
        unfinishedRetryTask?.cancel()
    }
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
    var giftsEnabled = true
    var autoPaywall = true
    var isPremiumMember = false
    var sessionLength = 20.0
    var lastMood = "Overwhelmed"
    var lastMoodIntensity = 5.0
    var coins = 300
    var appliedCoinTransactionIDs: [String] = []
    var pendingLobbyAudienceOperationID: String?
    var pendingLobbyAudienceViewers: Int?
    var lobbyJoinCount = 500
    var lobbyArriveTime = 1.0
    var selectedViewerPackLabel: String?
    var selectedVibes = ["Fan", "Supporter"]
    var activeCommentCategories = ["general", "agree", "disagree", "compliment"]
    var savedVideos: [SavedLiveVideo] = []
    var rewardSubmissions: [RewardSubmission] = []
    var completedLiveSessions = 0
    var hasStartedLiveSession = false
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
        case giftsEnabled
        case autoPaywall
        case isPremiumMember
        case sessionLength
        case lastMood
        case lastMoodIntensity
        case coins
        case appliedCoinTransactionIDs
        case pendingLobbyAudienceOperationID
        case pendingLobbyAudienceViewers
        case lobbyJoinCount
        case lobbyArriveTime
        case selectedViewerPackLabel
        case selectedVibes
        case activeCommentCategories
        case savedVideos
        case rewardSubmissions
        case completedLiveSessions
        case hasStartedLiveSession
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
        giftsEnabled = try container.decodeIfPresent(Bool.self, forKey: .giftsEnabled) ?? true
        autoPaywall = try container.decodeIfPresent(Bool.self, forKey: .autoPaywall) ?? true
        isPremiumMember = try container.decodeIfPresent(Bool.self, forKey: .isPremiumMember) ?? false
        sessionLength = try container.decodeIfPresent(Double.self, forKey: .sessionLength) ?? 20.0
        lastMood = try container.decodeIfPresent(String.self, forKey: .lastMood) ?? "Overwhelmed"
        lastMoodIntensity = try container.decodeIfPresent(Double.self, forKey: .lastMoodIntensity) ?? 5.0
        coins = try container.decodeIfPresent(Int.self, forKey: .coins) ?? 300
        appliedCoinTransactionIDs = try container.decodeIfPresent([String].self, forKey: .appliedCoinTransactionIDs) ?? []
        pendingLobbyAudienceOperationID = try container.decodeIfPresent(String.self, forKey: .pendingLobbyAudienceOperationID)
        pendingLobbyAudienceViewers = try container.decodeIfPresent(Int.self, forKey: .pendingLobbyAudienceViewers)
        lobbyJoinCount = try container.decodeIfPresent(Int.self, forKey: .lobbyJoinCount) ?? 500
        lobbyArriveTime = try container.decodeIfPresent(Double.self, forKey: .lobbyArriveTime) ?? 1.0
        selectedViewerPackLabel = try container.decodeIfPresent(String.self, forKey: .selectedViewerPackLabel)
        selectedVibes = try container.decodeIfPresent([String].self, forKey: .selectedVibes) ?? ["Fan", "Supporter"]
        activeCommentCategories = try container.decodeIfPresent([String].self, forKey: .activeCommentCategories) ?? ["general", "agree", "disagree", "compliment"]
        savedVideos = try container.decodeIfPresent([SavedLiveVideo].self, forKey: .savedVideos) ?? []
        rewardSubmissions = try container.decodeIfPresent([RewardSubmission].self, forKey: .rewardSubmissions) ?? []
        completedLiveSessions = try container.decodeIfPresent(Int.self, forKey: .completedLiveSessions) ?? 0
        hasStartedLiveSession = try container.decodeIfPresent(Bool.self, forKey: .hasStartedLiveSession) ?? (completedLiveSessions > 0)
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
    var localVideoFilename: String?
    var downloadedAt: Date?
    var likes: Int?
    var commentCount: Int?
    var giftCount: Int?
}

private struct LiveSessionSummary {
    let duration: Int
    let peakViewers: Int
    let likes: Int
    let comments: Int
    let gifts: Int
    let recordingURL: URL?
}

private enum LiveRecordingStore {
    static func persistTemporaryRecording(_ sourceURL: URL?, id: UUID) -> String? {
        guard let sourceURL else { return nil }
        let filename = "\(id.uuidString).mov"
        let destinationURL = recordingsDirectory.appendingPathComponent(filename)
        do {
            try FileManager.default.createDirectory(at: recordingsDirectory, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destinationURL.path) {
                try FileManager.default.removeItem(at: destinationURL)
            }
            try FileManager.default.moveItem(at: sourceURL, to: destinationURL)
            return filename
        } catch {
            return nil
        }
    }

    static func url(for filename: String?) -> URL? {
        guard let filename else { return nil }
        let url = recordingsDirectory.appendingPathComponent(filename)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private static var recordingsDirectory: URL {
        let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return baseURL.appendingPathComponent("SquadLiveRecordings", isDirectory: true)
    }
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
    let gender: AICompanionGender
    let replyStyle: String
}

private enum AICompanionGender: String {
    case woman
    case man

    var label: String {
        switch self {
        case .woman: "Woman"
        case .man: "Man"
        }
    }
}

private enum AICompanionCatalog {
    static let friends: [AIFriend] = [
        AIFriend(name: "Sophia", role: "Hype Queen", emoji: "🔥", imageURL: "https://randomuser.me/api/portraits/women/44.jpg", gender: .woman, replyStyle: "Warm, expressive, and encouraging"),
        AIFriend(name: "Madison", role: "Sweet Support", emoji: "💕", imageURL: "https://randomuser.me/api/portraits/women/68.jpg", gender: .woman, replyStyle: "Gentle, caring, and affirming"),
        AIFriend(name: "Riley", role: "The Comedian", emoji: "😂", imageURL: "https://randomuser.me/api/portraits/women/12.jpg", gender: .woman, replyStyle: "Playful, bright, and uplifting"),
        AIFriend(name: "Ava", role: "Deep Thinker", emoji: "🤔", imageURL: "https://randomuser.me/api/portraits/women/79.jpg", gender: .woman, replyStyle: "Thoughtful, reflective, and calm"),
        AIFriend(name: "Emma", role: "Gentle Soul", emoji: "🌸", imageURL: "https://randomuser.me/api/portraits/women/32.jpg", gender: .woman, replyStyle: "Soft-spoken, empathetic, and reassuring"),
        AIFriend(name: "Zoe", role: "Loyal Fan", emoji: "👑", imageURL: "https://randomuser.me/api/portraits/women/26.jpg", gender: .woman, replyStyle: "Confident, devoted, and celebratory"),
        AIFriend(name: "Mia", role: "Drama Queen", emoji: "🎭", imageURL: "https://randomuser.me/api/portraits/women/89.jpg", gender: .woman, replyStyle: "Bold, playful, and expressive"),
        AIFriend(name: "Chloe", role: "Cheerleader", emoji: "✨", imageURL: "https://randomuser.me/api/portraits/women/53.jpg", gender: .woman, replyStyle: "Bright, enthusiastic, and supportive"),
        AIFriend(name: "Luna", role: "Night Owl", emoji: "🌙", imageURL: "https://randomuser.me/api/portraits/women/21.jpg", gender: .woman, replyStyle: "Relaxed, intimate, and observant"),
        AIFriend(name: "Harper", role: "Soft Voice", emoji: "💫", imageURL: "https://randomuser.me/api/portraits/women/65.jpg", gender: .woman, replyStyle: "Tender, attentive, and calming"),
        AIFriend(name: "Nora", role: "Calm Coach", emoji: "🫶", imageURL: "https://randomuser.me/api/portraits/women/36.jpg", gender: .woman, replyStyle: "Clear, balanced, and reassuring"),
        AIFriend(name: "Ivy", role: "Bright Spark", emoji: "⚡️", imageURL: "https://randomuser.me/api/portraits/women/7.jpg", gender: .woman, replyStyle: "Optimistic, lively, and motivating"),
        AIFriend(name: "Liam", role: "Steady Guide", emoji: "🧭", imageURL: "https://randomuser.me/api/portraits/men/32.jpg", gender: .man, replyStyle: "Grounded, practical, and reassuring"),
        AIFriend(name: "Noah", role: "Calm Listener", emoji: "🌊", imageURL: "https://randomuser.me/api/portraits/men/46.jpg", gender: .man, replyStyle: "Patient, calm, and attentive"),
        AIFriend(name: "Ethan", role: "Confidence Coach", emoji: "⚡️", imageURL: "https://randomuser.me/api/portraits/men/11.jpg", gender: .man, replyStyle: "Direct, encouraging, and action-focused"),
        AIFriend(name: "Miles", role: "Warm Humor", emoji: "😄", imageURL: "https://randomuser.me/api/portraits/men/65.jpg", gender: .man, replyStyle: "Lighthearted, kind, and energizing"),
        AIFriend(name: "Leo", role: "Thoughtful Ally", emoji: "🪶", imageURL: "https://randomuser.me/api/portraits/men/75.jpg", gender: .man, replyStyle: "Reflective, sincere, and supportive"),
        AIFriend(name: "Owen", role: "Quiet Strength", emoji: "🛡️", imageURL: "https://randomuser.me/api/portraits/men/52.jpg", gender: .man, replyStyle: "Steady, composed, and reassuring")
    ] + localFriends

    private static let localFriends: [AIFriend] = [
        AIFriend(name: "Avery", role: "Community Voice", emoji: "💬", imageURL: "bundle-resource://audience-avatar-01.jpg", gender: .woman, replyStyle: "Natural, curious, and conversational"),
        AIFriend(name: "Brooklyn", role: "Bright Energy", emoji: "🌟", imageURL: "bundle-resource://audience-avatar-02.jpg", gender: .woman, replyStyle: "Lively, upbeat, and expressive"),
        AIFriend(name: "Camila", role: "Warm Welcome", emoji: "👋", imageURL: "bundle-resource://audience-avatar-03.jpg", gender: .woman, replyStyle: "Friendly, warm, and welcoming"),
        AIFriend(name: "Daisy", role: "Positive Spark", emoji: "🌼", imageURL: "bundle-resource://audience-avatar-04.jpg", gender: .woman, replyStyle: "Optimistic, kind, and encouraging"),
        AIFriend(name: "Elena", role: "Thoughtful Fan", emoji: "✨", imageURL: "bundle-resource://audience-avatar-05.jpg", gender: .woman, replyStyle: "Attentive, sincere, and reflective"),
        AIFriend(name: "Freya", role: "Fun Listener", emoji: "🎉", imageURL: "bundle-resource://audience-avatar-06.jpg", gender: .woman, replyStyle: "Playful, social, and spontaneous"),
        AIFriend(name: "Grace", role: "Kind Support", emoji: "🫶", imageURL: "bundle-resource://audience-avatar-07.jpg", gender: .woman, replyStyle: "Gentle, caring, and supportive"),
        AIFriend(name: "Hazel", role: "Curious Mind", emoji: "👀", imageURL: "bundle-resource://audience-avatar-08.jpg", gender: .woman, replyStyle: "Curious, observant, and engaging"),
        AIFriend(name: "Isla", role: "Chill Vibes", emoji: "🌊", imageURL: "bundle-resource://audience-avatar-09.jpg", gender: .woman, replyStyle: "Relaxed, calm, and easygoing"),
        AIFriend(name: "Jade", role: "Bold Opinion", emoji: "💚", imageURL: "bundle-resource://audience-avatar-10.jpg", gender: .woman, replyStyle: "Confident, direct, and lively"),
        AIFriend(name: "Kira", role: "Quick Wit", emoji: "😄", imageURL: "bundle-resource://audience-avatar-11.jpg", gender: .woman, replyStyle: "Witty, bright, and playful"),
        AIFriend(name: "Layla", role: "Soft Cheer", emoji: "💖", imageURL: "bundle-resource://audience-avatar-12.jpg", gender: .woman, replyStyle: "Sweet, positive, and affirming"),
        AIFriend(name: "Maya", role: "Real Talk", emoji: "🗣️", imageURL: "bundle-resource://audience-avatar-13.jpg", gender: .woman, replyStyle: "Honest, grounded, and conversational"),
        AIFriend(name: "Nina", role: "Happy Helper", emoji: "😊", imageURL: "bundle-resource://audience-avatar-14.jpg", gender: .woman, replyStyle: "Cheerful, helpful, and reassuring"),
        AIFriend(name: "Olivia", role: "Loyal Viewer", emoji: "💜", imageURL: "bundle-resource://audience-avatar-15.jpg", gender: .woman, replyStyle: "Loyal, warm, and celebratory"),
        AIFriend(name: "Piper", role: "Playful Guest", emoji: "🤭", imageURL: "bundle-resource://audience-avatar-16.jpg", gender: .woman, replyStyle: "Playful, mischievous, and fun"),
        AIFriend(name: "Quinn", role: "Calm Perspective", emoji: "🧠", imageURL: "bundle-resource://audience-avatar-17.jpg", gender: .woman, replyStyle: "Balanced, thoughtful, and measured"),
        AIFriend(name: "Ruby", role: "Hype Friend", emoji: "❤️", imageURL: "bundle-resource://audience-avatar-18.jpg", gender: .woman, replyStyle: "Energetic, enthusiastic, and supportive"),
        AIFriend(name: "Sienna", role: "Charming Fan", emoji: "🥰", imageURL: "bundle-resource://audience-avatar-19.jpg", gender: .woman, replyStyle: "Warm, expressive, and affectionate"),
        AIFriend(name: "Tessa", role: "Friendly Critic", emoji: "🤨", imageURL: "bundle-resource://audience-avatar-20.jpg", gender: .woman, replyStyle: "Candid, playful, and discerning"),
        AIFriend(name: "Uma", role: "Quiet Fan", emoji: "🌙", imageURL: "bundle-resource://audience-avatar-21.jpg", gender: .woman, replyStyle: "Reserved, observant, and kind"),
        AIFriend(name: "Violet", role: "Creative Soul", emoji: "🎨", imageURL: "bundle-resource://audience-avatar-22.jpg", gender: .woman, replyStyle: "Imaginative, expressive, and curious"),
        AIFriend(name: "Willow", role: "Gentle Observer", emoji: "🌿", imageURL: "bundle-resource://audience-avatar-23.jpg", gender: .woman, replyStyle: "Calm, gentle, and perceptive"),
        AIFriend(name: "Ximena", role: "Social Butterfly", emoji: "🦋", imageURL: "bundle-resource://audience-avatar-24.jpg", gender: .woman, replyStyle: "Social, upbeat, and welcoming"),
        AIFriend(name: "Yara", role: "Fresh Take", emoji: "💡", imageURL: "bundle-resource://audience-avatar-25.jpg", gender: .woman, replyStyle: "Fresh, curious, and thoughtful"),
        AIFriend(name: "Amir", role: "Steady Fan", emoji: "👍", imageURL: "bundle-resource://audience-avatar-26.jpg", gender: .man, replyStyle: "Grounded, friendly, and encouraging"),
        AIFriend(name: "Ben", role: "Funny Viewer", emoji: "🤣", imageURL: "bundle-resource://audience-avatar-27.jpg", gender: .man, replyStyle: "Lighthearted, funny, and social"),
        AIFriend(name: "Carter", role: "Skeptical Voice", emoji: "🤔", imageURL: "bundle-resource://audience-avatar-28.jpg", gender: .man, replyStyle: "Skeptical, direct, and observant"),
        AIFriend(name: "Diego", role: "Good Energy", emoji: "🙌", imageURL: "bundle-resource://audience-avatar-29.jpg", gender: .man, replyStyle: "Positive, expressive, and energetic")
    ]

    static var defaultListeners: [Listener] {
        listeners(for: Array(friends.prefix(3)).map(\.imageURL))
    }

    static func listeners(for imageURLs: [String]) -> [Listener] {
        imageURLs.compactMap { imageURL in
            friends.first { $0.imageURL == imageURL }
        }
        .map {
                Listener(
                    id: $0.name.lowercased(),
                    name: $0.name,
                    avatar: $0.emoji,
                    imageURL: $0.imageURL,
                    role: $0.role,
                    description: $0.replyStyle,
                    gender: $0.gender,
                    replyStyle: $0.replyStyle
                )
            }
    }
}

private enum ChatCommentKind: String, Codable {
    case barrage
    case deepAnswer
    case userSpeech
}

private struct ChatComment: Identifiable, Codable {
    let id: UUID
    let name: String
    let avatar: String
    var text: String
    var kind: ChatCommentKind
    let createdAt: Date

    init(id: UUID = UUID(), name: String, avatar: String, text: String, kind: ChatCommentKind = .barrage, createdAt: Date = Date()) {
        self.id = id
        self.name = name
        self.avatar = avatar
        self.text = text
        self.kind = kind
        self.createdAt = createdAt
    }
}

private enum LiveChatHistoryStore {
    private static let key = "squadlive.ai-chat-history"

    static func load() -> [ChatComment] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let comments = try? JSONDecoder().decode([ChatComment].self, from: data) else {
            return []
        }
        return comments.filter { ($0.kind == .deepAnswer || $0.kind == .userSpeech) && $0.text != "•••" }
    }

    static func save(_ comments: [ChatComment]) {
        let retained = Array(comments.filter { ($0.kind == .deepAnswer || $0.kind == .userSpeech) && $0.text != "•••" }.suffix(240))
        guard let data = try? JSONEncoder().encode(retained) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

private struct FloatingHeart: Identifiable {
    let id = UUID()
    let emoji: String
    let xOffset: CGFloat
}

private enum AppReviewStrategy {
    static func requestFromLive(preferences: inout AppPreferences) {
        preferences.reviewPositiveMoments += 2
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
            guard settings.authorizationStatus == .authorized else { return }
            scheduleDailyPromotions()
        }
    }

    static func requestAuthorizationIfNeeded(completion: @escaping () -> Void) {
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                requestAuthorization(completion: completion)
            case .authorized, .provisional, .ephemeral:
                scheduleDailyPromotions()
                completion()
            case .denied:
                completion()
            @unknown default:
                completion()
            }
        }
    }

    private static func requestAuthorization(completion: @escaping () -> Void) {
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            if granted {
                scheduleDailyPromotions()
            }
            completion()
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
    struct ThinkingMode: Encodable {
        let type: String
    }

    let model: String
    let thinking: ThinkingMode
    let messages: [DeepSeekMessage]
    let temperature: Double
    let maxTokens: Int

    enum CodingKeys: String, CodingKey {
        case model
        case thinking
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
    let history: [DeepSeekMessage]
    let deviceId: String
    let userName: String
    let listener: ListenerPayload
    let roleMode: String
    let replyDepth: Double
    let activeDirections: [String]
    let toneTopics: [String]
    let vibeMoods: [String]
    let liveSeconds: Int
    let sceneContext: String
    let inputLanguage: String
    let interactionType: String

    struct ListenerPayload: Encodable {
        let name: String
        let role: String
        let gender: String
        let replyStyle: String
    }
}

private struct SquadLiveAIProxyResponse: Decodable {
    let answer: String
    let source: String?
    let reason: String?
    let providerStatus: Int?
}

private struct DeepSeekAnswerResult {
    let text: String
    let source: String
    let reason: String?

    var isDeepSeek: Bool { source == "deepseek" }
    var shouldRetry: Bool {
        reason == "network_error" || reason == "provider_error" || reason == "empty_response" || reason == "timeout"
    }
}

enum SquadLiveDeviceIdentity {
    private static let storageKey = "squadlive.device-id"

    static let value: String = {
        if let saved = UserDefaults.standard.string(forKey: storageKey), !saved.isEmpty {
            return saved
        }
#if os(iOS)
        let generated = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
#else
        let generated = UUID().uuidString
#endif
        UserDefaults.standard.set(generated, forKey: storageKey)
        return generated
    }()

    static var appAccountToken: UUID? {
        UUID(uuidString: value)
    }

    static var purchaseAccountToken: UUID? {
        SquadLivePartnerAttributionClient.purchaseAccountToken ?? appAccountToken
    }
}

#if os(iOS)
@MainActor
private final class AppleSignInCoordinator: NSObject, ObservableObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    @Published var isSigningIn = false
    @Published var message: String?
    private var completion: ((String, String?) -> Void)?

    func start(completion: @escaping (String, String?) -> Void) {
        guard !isSigningIn else { return }
        self.completion = completion
        isSigningIn = true
        message = nil
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8) else {
            isSigningIn = false
            message = "Apple sign-in could not be verified."
            return
        }
        let name = [credential.fullName?.givenName, credential.fullName?.familyName].compactMap { $0 }.joined(separator: " ")
        isSigningIn = false
        completion?(identityToken, name.isEmpty ? nil : name)
        completion = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        isSigningIn = false
        if (error as? ASAuthorizationError)?.code != .canceled {
            message = "Apple sign-in failed. Please try again."
        }
        completion = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })?
            .windows.first(where: { $0.isKeyWindow }) ?? UIWindow(frame: UIScreen.main.bounds)
    }
}
#endif

private struct StoreCoinClaimRequest: Encodable {
    let deviceId: String
    let signedTransaction: String
}

private struct StoreCoinClaimResponse: Decodable {
    let creditedCoins: Int
    let balance: Int
    let duplicate: Bool
    let transactionId: String
}

private struct StoreWalletUser: Decodable {
    let id: String?
    let deviceId: String?
    let coins: Int
    let liveSessionsStarted: Int?
    let firstLiveFreeAvailable: Bool?
    let accountLinked: Bool?
}

private struct StoreWalletBalanceResponse: Decodable {
    let user: StoreWalletUser
}

private struct StoreSupportIdentity {
    let backendUserID: String
    let lookupID: String
}

private struct StoreWalletAudienceResponse: Decodable {
    let user: StoreWalletUser
    let cost: Int
    let regularCost: Int?
    let firstLiveFree: Bool?
    let duplicate: Bool
}

private struct StoreWalletRewardSubmission: Decodable {
    let baseRewardCoins: Int
}

private struct StoreWalletRewardResponse: Decodable {
    let user: StoreWalletUser
    let submission: StoreWalletRewardSubmission?
    let duplicate: Bool
}

private struct StoreWalletErrorResponse: Decodable {
    let error: String
    let coins: Int?
}

private struct StoreWalletDeviceRequest: Encodable {
    let deviceId: String
}

private struct StoreAppleAccountLinkRequest: Encodable {
    let deviceId: String
    let identityToken: String
    let displayName: String?
}

private struct StoreAppleAccountLinkResponse: Decodable {
    let user: StoreWalletUser
}

private struct StoreWalletAudienceRequest: Encodable {
    let deviceId: String
    let operationId: String
    let viewers: Int
    let context: String
}

private struct StoreWalletRewardRequest: Encodable {
    let deviceId: String
    let operationId: String
    let platform: String
    let proofLink: String
    let screenshotBase64: Data?
}

private struct LiveEngagementEventRequest: Encodable {
    let deviceId: String
    let eventId: String
    let sessionId: String
    let type: String
    let durationSeconds: Int?
    let reason: String?
}

private enum LiveEngagementClient {
    private static let productionBackendURL = URL(string: "https://squadlive.onrender.com")!

    private static var backendBaseURL: URL {
        guard let rawBaseURL = Bundle.main.object(forInfoDictionaryKey: "SQUADLIVE_API_BASE_URL") as? String,
              !rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let configuredURL = URL(string: rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return productionBackendURL
        }
        return configuredURL
    }

    static func report(type: String, sessionId: UUID, durationSeconds: Int? = nil, reason: String? = nil) async {
        var request = URLRequest(url: backendBaseURL.appendingPathComponent("v1/live/events"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 12
        do {
            request.httpBody = try JSONEncoder().encode(LiveEngagementEventRequest(
                deviceId: SquadLiveDeviceIdentity.value,
                eventId: UUID().uuidString,
                sessionId: sessionId.uuidString,
                type: type,
                durationSeconds: durationSeconds,
                reason: reason
            ))
            _ = try await URLSession.shared.data(for: request)
        } catch {
            print("SquadLive live event failed: \(error.localizedDescription)")
        }
    }
}

private enum StoreWalletSpendResult {
    case success(balance: Int, cost: Int, regularCost: Int, firstLiveFree: Bool)
    case insufficient(balance: Int)
    case unavailable
}

private struct StoreSubscriptionClaimResponse: Decodable {
    let duplicate: Bool
    let transactionId: String
}

private enum StoreBackendClient {
    private static let productionBackendURL = URL(string: "https://squadlive.onrender.com")!

    private static var backendBaseURL: URL {
        guard let rawBaseURL = Bundle.main.object(forInfoDictionaryKey: "SQUADLIVE_API_BASE_URL") as? String,
              !rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let configuredURL = URL(string: rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return productionBackendURL
        }
        return configuredURL
    }

    static func claimCoins(signedTransaction: String) async -> StoreCoinClaimResponse? {
        await claim(
            path: "v1/storekit/coins/claim",
            signedTransaction: signedTransaction,
            responseType: StoreCoinClaimResponse.self
        )
    }

    static func claimSubscription(signedTransaction: String) async -> Bool {
        let response = await claim(
            path: "v1/storekit/subscriptions/claim",
            signedTransaction: signedTransaction,
            responseType: StoreSubscriptionClaimResponse.self
        )
        return response != nil
    }

    static func fetchWalletState() async -> StoreWalletUser? {
        let response: StoreWalletBalanceResponse? = await post(
            path: "v1/wallet/balance",
            body: StoreWalletDeviceRequest(deviceId: SquadLiveDeviceIdentity.value)
        )
        return response?.user
    }

    static func linkAppleAccount(identityToken: String, displayName: String?) async -> StoreWalletUser? {
        let response: StoreAppleAccountLinkResponse? = await post(
            path: "v1/auth/apple",
            body: StoreAppleAccountLinkRequest(
                deviceId: SquadLiveDeviceIdentity.value,
                identityToken: identityToken,
                displayName: displayName
            )
        )
        return response?.user
    }

    static func fetchWalletBalance() async -> Int? {
        await fetchWalletState()?.coins
    }

    static func fetchWalletStateWithRetry() async -> StoreWalletUser? {
        let retryDelays: [TimeInterval] = [0, 2, 6, 15]
        for (index, delay) in retryDelays.enumerated() {
            if delay > 0 {
                try? await Task.sleep(for: .seconds(delay))
            }
            if let user = await fetchWalletState() {
                SquadLiveAnalytics.log("backend_registration_succeeded", parameters: ["attempt": index + 1])
                return user
            }
        }
        SquadLiveAnalytics.log("backend_registration_failed", parameters: ["attempts": retryDelays.count])
        return nil
    }

    static func fetchWalletBalanceWithRetry() async -> Int? {
        await fetchWalletStateWithRetry()?.coins
    }

    static func fetchSupportIdentity() async -> StoreSupportIdentity? {
        let response: StoreWalletBalanceResponse? = await post(
            path: "v1/wallet/balance",
            body: StoreWalletDeviceRequest(deviceId: SquadLiveDeviceIdentity.value)
        )
        guard let backendUserID = response?.user.id, !backendUserID.isEmpty else { return nil }
        return StoreSupportIdentity(
            backendUserID: backendUserID,
            lookupID: response?.user.deviceId ?? SquadLiveDeviceIdentity.value
        )
    }

    static func commitAudiencePurchase(viewers: Int, context: String, operationId: UUID) async -> StoreWalletSpendResult {
        var request = URLRequest(url: backendBaseURL.appendingPathComponent("v1/audience/commit"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 20

        do {
            request.httpBody = try JSONEncoder().encode(StoreWalletAudienceRequest(
                deviceId: SquadLiveDeviceIdentity.value,
                operationId: operationId.uuidString,
                viewers: viewers,
                context: context
            ))
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { return .unavailable }
            if (200..<300).contains(httpResponse.statusCode) {
                let decoded = try JSONDecoder().decode(StoreWalletAudienceResponse.self, from: data)
                return .success(
                    balance: decoded.user.coins,
                    cost: decoded.cost,
                    regularCost: decoded.regularCost ?? decoded.cost,
                    firstLiveFree: decoded.firstLiveFree ?? false
                )
            }
            if httpResponse.statusCode == 402,
               let decoded = try? JSONDecoder().decode(StoreWalletErrorResponse.self, from: data) {
                return .insufficient(balance: decoded.coins ?? 0)
            }
            return .unavailable
        } catch {
            print("SquadLive wallet purchase failed: \(error.localizedDescription)")
            return .unavailable
        }
    }

    static func submitShareReward(
        operationId: UUID,
        platform: String,
        proofLink: String,
        screenshotData: Data?
    ) async -> StoreWalletRewardResponse? {
        await post(
            path: "v1/rewards/share-submissions",
            body: StoreWalletRewardRequest(
                deviceId: SquadLiveDeviceIdentity.value,
                operationId: operationId.uuidString,
                platform: platform,
                proofLink: proofLink,
                screenshotBase64: screenshotData
            )
        )
    }

    private static func claim<Response: Decodable>(
        path: String,
        signedTransaction: String,
        responseType: Response.Type
    ) async -> Response? {
        var request = URLRequest(url: backendBaseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 20

        do {
            request.httpBody = try JSONEncoder().encode(StoreCoinClaimRequest(
                deviceId: SquadLiveDeviceIdentity.value,
                signedTransaction: signedTransaction
            ))
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                print("SquadLive Store backend returned HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1)")
                return nil
            }
            return try JSONDecoder().decode(responseType, from: data)
        } catch {
            print("SquadLive Store backend verification failed: \(error.localizedDescription)")
            return nil
        }
    }

    private static func post<Body: Encodable, Response: Decodable>(
        path: String,
        body: Body
    ) async -> Response? {
        var request = URLRequest(url: backendBaseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 20

        do {
            request.httpBody = try JSONEncoder().encode(body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            print("SquadLive wallet request failed: \(error.localizedDescription)")
            return nil
        }
    }
}

private enum DeepSeekClient {
    private static let productionBackendURL = URL(string: "https://squadlive.onrender.com")!

    private static var backendBaseURL: URL {
        guard let rawBaseURL = Bundle.main.object(forInfoDictionaryKey: "SQUADLIVE_API_BASE_URL") as? String,
              !rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let configuredURL = URL(string: rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return productionBackendURL
        }
        return configuredURL
    }

    private static let backendSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 18
        configuration.timeoutIntervalForResource = 24
        configuration.httpMaximumConnectionsPerHost = 4
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    static func warmBackend() async {
        var request = URLRequest(url: backendBaseURL.appendingPathComponent("health"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 55)
        request.httpMethod = "GET"
        _ = try? await backendSession.data(for: request)
    }

    static func answer(userText: String, history: [DeepSeekMessage], userName: String, listener: Listener, roleMode: String, replyDepth: Double, activeDirections: [String], toneTopics: [String], vibeMoods: [String], liveSeconds: Int, sceneContext: String, inputLanguageOverride: String? = nil, interactionType: String = "user") async -> DeepSeekAnswerResult? {
        let inputLanguage = inputLanguageOverride ?? detectedLanguageCode(for: userText)
        let backendAnswer = await answerViaBackend(
            userText: userText,
            history: history,
            userName: userName,
            listener: listener,
            roleMode: roleMode,
            replyDepth: replyDepth,
            activeDirections: activeDirections,
            toneTopics: toneTopics,
            vibeMoods: vibeMoods,
            liveSeconds: liveSeconds,
            sceneContext: sceneContext,
            inputLanguage: inputLanguage,
            interactionType: interactionType
        )
        if let backendAnswer, backendAnswer.isDeepSeek {
            return backendAnswer
        }

        guard let apiKey = Bundle.main.object(forInfoDictionaryKey: "DEEPSEEK_API_KEY") as? String,
              !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let url = URL(string: "https://api.deepseek.com/chat/completions") else {
            return backendAnswer
        }

        let directionGuide = Self.directionGuide(activeDirections)
        let toneGuide = toneTopics.isEmpty ? "General" : toneTopics.joined(separator: ", ")
        let vibeGuide = vibeMoods.isEmpty ? "Warm, calm" : vibeMoods.joined(separator: ", ")
        let vibeBehaviorGuide = Self.vibeBehaviorGuide(vibeMoods)
        let liveStage = liveSeconds < 60 ? "opening" : (liveSeconds < 300 ? "active" : "late")
        let systemPrompt = """
        You are \(listener.name), a virtual live-room friend inside SquadLive.
        Act like an attentive, emotionally intelligent member of the live audience. Stay focused on what the streamer says, how the conversation develops, and any safe visual context provided below.
        Companion gender: \(listener.gender.label).
        Reply style: \(listener.replyStyle).
        Role mode: \(roleMode).
        Live stage: \(liveStage).
        Current visual context: \(sceneContext.isEmpty ? "The latest frame is still being analyzed. Do not claim that you cannot see the stream; ask the user to hold the item closer if visual detail matters." : sceneContext)
        Required response language code: \(inputLanguage). Reply entirely in this language. Do not switch languages because of device settings, previous messages, names, or visual labels.
        Tone topics: \(toneGuide).
        Vibe mood: \(vibeGuide).
        Vibe behavior: \(vibeBehaviorGuide)
        Vibe behavior overrides role mode and tone directions whenever they conflict.
        Reply directly to the user based on what they just said.
        Answer the actual question or intent first. If the speech transcript is incomplete, garbled, or ambiguous, ask one brief clarification instead of guessing.
        \(directionGuide)
        Keep it specific and natural.
        Unless Haters vibe is active, include a compliment only when it is relevant to what the user just said or to reliable visual context. Do not force a compliment into every reply.
        Occasionally include one context-appropriate emoji for warmth or emphasis, but not in every reply and never more than one emoji.
        Do not repeat the same compliment style twice in a row.
        Avoid generic greetings and avoid sounding scripted.
        Do not merely repeat or paraphrase the user's words. React to their meaning and move the conversation forward.
        Use visual context only when it directly helps with the user's latest message. Treat visual labels as uncertain, use phrasing such as "it looks like" when needed, and never infer sensitive traits, health, identity, or private information. Never say that you cannot see the stream.
        If the user says it is nice to meet you, warmly say it is nice to meet them too and ask one natural follow-up question.
        Always reply in the language identified by the required response language code. Do not switch languages because of device settings, earlier messages, names, or visual labels.
        Usually use 1-2 short sentences, but do not force an unnatural cutoff. When the topic genuinely benefits from detail, a deeper reply may use 3-4 concise sentences. Avoid long, repetitive paragraphs.
        """
        let body = DeepSeekChatRequest(
            model: "deepseek-v4-flash",
            thinking: .init(type: "disabled"),
            messages: [DeepSeekMessage(role: "system", content: systemPrompt)]
                + history
                + [DeepSeekMessage(role: "user", content: userText)],
            temperature: min(0.9, max(0.45, 0.52 + replyDepth * 0.32)),
            maxTokens: replyDepth > 0.72 ? 80 : 64
        )

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 18

        do {
            request.httpBody = try JSONEncoder().encode(body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return backendAnswer
            }
            let decoded = try JSONDecoder().decode(DeepSeekChatResponse.self, from: data)
            guard let answer = decoded.choices.first?.message.content else { return backendAnswer }
            return DeepSeekAnswerResult(
                text: enrichedReply(answer, matching: userText, replyDepth: replyDepth),
                source: "deepseek",
                reason: nil
            )
        } catch {
            return backendAnswer
        }
    }

    private static func answerViaBackend(userText: String, history: [DeepSeekMessage], userName: String, listener: Listener, roleMode: String, replyDepth: Double, activeDirections: [String], toneTopics: [String], vibeMoods: [String], liveSeconds: Int, sceneContext: String, inputLanguage: String, interactionType: String) async -> DeepSeekAnswerResult? {
        let requestBody = SquadLiveAIProxyRequest(
            text: userText,
            history: history,
            deviceId: SquadLiveDeviceIdentity.value,
            userName: userName,
            listener: .init(name: listener.name, role: listener.role, gender: listener.gender.label, replyStyle: listener.replyStyle),
            roleMode: roleMode,
            replyDepth: replyDepth,
            activeDirections: activeDirections,
            toneTopics: toneTopics,
            vibeMoods: vibeMoods,
            liveSeconds: liveSeconds,
            sceneContext: sceneContext,
            inputLanguage: inputLanguage,
            interactionType: interactionType
        )

        var request = URLRequest(url: backendBaseURL.appendingPathComponent("v1/ai/deepseek"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 50

        do {
            request.httpBody = try JSONEncoder().encode(requestBody)
            let (data, response) = try await backendSession.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                print("SquadLive AI backend returned HTTP \(statusCode)")
                return DeepSeekAnswerResult(text: "", source: "fallback", reason: "provider_error")
            }
            let decoded = try JSONDecoder().decode(SquadLiveAIProxyResponse.self, from: data)
            return DeepSeekAnswerResult(
                text: enrichedReply(decoded.answer, matching: userText, replyDepth: replyDepth),
                source: decoded.source ?? "fallback",
                reason: decoded.reason
            )
        } catch {
            print("SquadLive AI backend request failed: \(error)")
            return DeepSeekAnswerResult(text: "", source: "fallback", reason: "network_error")
        }
    }

    private static func directionGuide(_ activeDirections: [String]) -> String {
        let labels = activeDirections.compactMap { direction -> String? in
            switch direction.lowercased() {
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

    private static func vibeBehaviorGuide(_ vibeMoods: [String]) -> String {
        if vibeMoods.contains("Haters") {
            return "Be skeptical, blunt, and lightly snarky. Challenge weak claims and tease the streamer without threats, slurs, discrimination, or attacks on protected traits. Do not add automatic compliments."
        }

        let guidance = vibeMoods.compactMap { vibe -> String? in
            switch vibe {
            case "Hype": return "React like an excited superfan with energetic encouragement and celebration."
            case "Happy": return "Sound cheerful, warm, optimistic, and genuinely delighted by the conversation."
            case "Flirty": return "Use playful, respectful flirting and light camera chemistry without becoming explicit or possessive."
            case "Funny": return "Prioritize playful jokes, witty reactions, callbacks, and comedic timing."
            case "Curious": return "Ask specific follow-up questions and explore details instead of giving generic praise."
            default: return nil
            }
        }
        return guidance.isEmpty ? "Stay warm and conversational." : guidance.joined(separator: " ")
    }

    static func detectedLanguageCode(for text: String) -> String {
        let scalars = text.unicodeScalars
        if scalars.contains(where: { (0x3040...0x30FF).contains(Int($0.value)) }) { return "ja" }
        if scalars.contains(where: { (0xAC00...0xD7AF).contains(Int($0.value)) }) { return "ko" }
        if scalars.contains(where: { (0x3400...0x9FFF).contains(Int($0.value)) }) { return "zh-Hans" }
        if scalars.contains(where: { (0x0600...0x06FF).contains(Int($0.value)) }) { return "ar" }
        if scalars.contains(where: { (0x0400...0x04FF).contains(Int($0.value)) }) { return "ru" }

        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        if let best = recognizer.languageHypotheses(withMaximum: 3).max(by: { $0.value < $1.value }),
           best.value >= 0.35 {
            return best.key.rawValue
        }
        return "en"
    }

    private static func conciseReply(_ answer: String, matching userText: String, replyDepth: Double) -> String {
        let cleanAnswer = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefersDepth = replyDepth > 0.72
        let limit = prefersDepth ? 360 : 240
        guard cleanAnswer.count > limit else { return cleanAnswer }
        return String(cleanAnswer.prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }

    private static func enrichedReply(_ answer: String, matching userText: String, replyDepth: Double) -> String {
        let concise = conciseReply(answer, matching: userText, replyDepth: replyDepth)
        guard !containsEmoji(concise) else { return concise }

        let seed = (concise + userText).unicodeScalars.reduce(0) { partial, scalar in
            ((partial &* 31) &+ Int(scalar.value)) & 0x7fffffff
        }
        guard seed % 100 < 38 else { return concise }

        let combined = (concise + " " + userText).lowercased()
        let emojis: [String]
        if combined.contains("哈哈") || combined.contains("好笑") || combined.contains("funny") || combined.contains("laugh") {
            emojis = ["😂", "😄"]
        } else if combined.contains("恭喜") || combined.contains("成功") || combined.contains("厉害") || combined.contains("congrat") || combined.contains("amazing") {
            emojis = ["🎉", "🔥", "👏"]
        } else if combined.contains("难过") || combined.contains("压力") || combined.contains("焦虑") || combined.contains("sad") || combined.contains("stress") || combined.contains("anxious") {
            emojis = ["🤍", "🌿", "🫶"]
        } else if combined.contains("喜欢") || combined.contains("爱") || combined.contains("漂亮") || combined.contains("love") || combined.contains("beautiful") {
            emojis = ["💜", "🥰", "✨"]
        } else if combined.contains("加油") || combined.contains("相信") || combined.contains("勇敢") || combined.contains("you can") || combined.contains("believe") {
            emojis = ["💪", "🙌", "✨"]
        } else {
            emojis = ["✨", "😊", "💜"]
        }
        return "\(concise) \(emojis[seed % emojis.count])"
    }

    private static func containsEmoji(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.properties.isEmojiPresentation }
    }
}

private final class SpeechTranscriber: ObservableObject {
    @Published var transcript = ""
    @Published var statusText = "Listening..."
    @Published private(set) var detectedLanguageCode = "en"

#if os(iOS)
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var activeRecognizer: SFSpeechRecognizer?
    private var nextLocaleIdentifier: String?
    private var restartWorkItem: DispatchWorkItem?
    private var sessionRefreshWorkItem: DispatchWorkItem?
    private var sessionID = UUID()
    private var shouldKeepListening = false
    private var availabilityRetryCount = 0
    private var committedTranscript = ""
    private let savedLocaleKey = "squadlive.speech-recognition-locale"
#endif

    func start() {
#if os(iOS)
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            statusText = "Speech recognition is not enabled."
            return
        }

        stop()
        committedTranscript = ""
        transcript = ""
        detectedLanguageCode = languageCode(forLocaleIdentifier: nextLocaleIdentifier ?? UserDefaults.standard.string(forKey: savedLocaleKey) ?? Locale.current.identifier)
        shouldKeepListening = true
        startRecognitionSession()
#else
        statusText = "Speech recognition runs on iPhone."
#endif
    }

    func stop() {
#if os(iOS)
        shouldKeepListening = false
        restartWorkItem?.cancel()
        restartWorkItem = nil
        sessionRefreshWorkItem?.cancel()
        sessionRefreshWorkItem = nil
        availabilityRetryCount = 0
        stopRecognitionSession(deactivateAudio: true)
#endif
    }

    @discardableResult
    func applyLanguageCommand(from text: String) -> String? {
#if os(iOS)
        let normalized = text
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
        let commandMarkers = [
            "speak ", "reply in ", "answer in ", "switch to ", "change to ",
            "use ", "用", "切换到", "换成", "请说", "用…回答", "用…说"
        ]
        guard commandMarkers.contains(where: { normalized.contains($0) }) else { return nil }

        let languages: [(aliases: [String], locale: String, code: String)] = [
            (["中文", "汉语", "chinese", "mandarin"], "zh-CN", "zh-Hans"),
            (["english", "英语", "英文"], "en-US", "en"),
            (["spanish", "espanol", "西班牙语"], "es-ES", "es"),
            (["french", "francais", "法语"], "fr-FR", "fr"),
            (["german", "deutsch", "德语"], "de-DE", "de"),
            (["japanese", "日本语", "日语"], "ja-JP", "ja"),
            (["korean", "한국어", "韩语"], "ko-KR", "ko"),
            (["portuguese", "portugues", "葡萄牙语"], "pt-BR", "pt"),
            (["italian", "italiano", "意大利语"], "it-IT", "it"),
            (["russian", "русский", "俄语"], "ru-RU", "ru"),
            (["arabic", "العربية", "阿拉伯语"], "ar-SA", "ar"),
            (["hindi", "हिन्दी", "印地语"], "hi-IN", "hi"),
            (["thai", "ไทย", "泰语"], "th-TH", "th"),
            (["vietnamese", "tieng viet", "越南语"], "vi-VN", "vi")
        ]
        guard let target = languages.first(where: { entry in
            entry.aliases.contains(where: { normalized.contains($0) })
        }), let locale = bestSupportedLocale(for: target.locale, in: Array(SFSpeechRecognizer.supportedLocales())) else {
            return nil
        }

        detectedLanguageCode = target.code
        nextLocaleIdentifier = locale.identifier
        UserDefaults.standard.set(locale.identifier, forKey: savedLocaleKey)
        statusText = "Switched to \(displayName(for: locale))"
        restartRecognitionSession()
        return target.code
#else
        return nil
#endif
    }

#if os(iOS)
    func appendAudioSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        recognitionRequest?.appendAudioSampleBuffer(sampleBuffer)
    }
#endif

#if os(iOS)
    private func startRecognitionSession() {
        guard shouldKeepListening else { return }

        stopRecognitionSession(deactivateAudio: false)
        statusText = "Listening..."
        sessionID = UUID()
        let activeSessionID = sessionID

        let preferredLocaleID = nextLocaleIdentifier
        nextLocaleIdentifier = nil
        guard let (localeID, recognizer) = firstAvailableRecognizer(preferredLocaleID: preferredLocaleID) else {
            scheduleAvailabilityRetry()
            return
        }
        availabilityRetryCount = 0
        activeRecognizer = recognizer
        detectedLanguageCode = languageCode(forLocaleIdentifier: localeID)
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        recognitionRequest = request
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.sessionID == activeSessionID else { return }
                if let result {
                    self.updateTranscript(from: result, localeID: localeID)
                }
                if error != nil || result?.isFinal == true {
                    self.restartRecognitionSession()
                }
            }
        }
        scheduleRecognitionSessionRefresh()
    }

    private func firstAvailableRecognizer(preferredLocaleID: String?) -> (String, SFSpeechRecognizer)? {
        var localeIDs = recognitionLocaleIDs()
        if let preferredLocaleID {
            localeIDs.removeAll { $0 == preferredLocaleID }
            localeIDs.insert(preferredLocaleID, at: 0)
        }
        if !localeIDs.contains("en-US") {
            localeIDs.append("en-US")
        }

        for localeID in localeIDs {
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeID)), recognizer.isAvailable else { continue }
            return (localeID, recognizer)
        }
        return nil
    }

    private func scheduleAvailabilityRetry() {
        guard shouldKeepListening else { return }
        sessionRefreshWorkItem?.cancel()
        sessionRefreshWorkItem = nil
        restartWorkItem?.cancel()
#if targetEnvironment(simulator)
        statusText = "Simulator voice recognition is reconnecting..."
#else
        statusText = "Voice recognition is reconnecting..."
#endif
        let retryDelays: [TimeInterval] = [0.8, 1.5, 3, 5, 8]
        let delay = retryDelays[min(availabilityRetryCount, retryDelays.count - 1)]
        availabilityRetryCount += 1
        let workItem = DispatchWorkItem { [weak self] in
            self?.startRecognitionSession()
        }
        restartWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private func updateTranscript(from result: SFSpeechRecognitionResult, localeID: String) {
        let sessionText = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sessionText.isEmpty else { return }
        let text = [committedTranscript, sessionText]
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        if text != transcript {
            transcript = text
        }

        if result.isFinal {
            committedTranscript = text
        }

        if result.isFinal, sessionText.count >= 4 {
            let detectedLanguage = DeepSeekClient.detectedLanguageCode(for: sessionText)
            detectedLanguageCode = detectedLanguage
            if let detectedLocale = bestSupportedLocale(for: detectedLanguage, in: Array(SFSpeechRecognizer.supportedLocales())) {
                if detectedLocale.identifier != localeID {
                    nextLocaleIdentifier = detectedLocale.identifier
                    statusText = "Detected \(displayName(for: detectedLocale))"
                } else {
                    UserDefaults.standard.set(localeID, forKey: savedLocaleKey)
                    detectedLanguageCode = detectedLanguage
                    statusText = "Detected \(displayName(for: detectedLocale))"
                }
                return
            }
        }

        let confidences = result.bestTranscription.segments.map(\.confidence).filter { $0 > 0 }
        guard result.isFinal, sessionText.count >= 3, !confidences.isEmpty else { return }
        let averageConfidence = confidences.reduce(0, +) / Float(confidences.count)
        if averageConfidence < 0.45 {
            let candidates = recognitionLocaleIDs()
            if let currentIndex = candidates.firstIndex(of: localeID), candidates.count > 1 {
                nextLocaleIdentifier = candidates[(currentIndex + 1) % candidates.count]
                statusText = "Checking another language..."
            }
        }
    }

    private func recognitionLocaleIDs() -> [String] {
        let supportedLocales = Array(SFSpeechRecognizer.supportedLocales())
        let savedIdentifier = UserDefaults.standard.string(forKey: savedLocaleKey)
        let commonLanguageIdentifiers = [
            "en-US", "zh-CN", "es-ES", "fr-FR", "de-DE", "ja-JP", "ko-KR",
            "pt-BR", "it-IT", "ru-RU", "ar-SA", "hi-IN", "th-TH", "vi-VN"
        ]
        let preferredIdentifiers = [savedIdentifier].compactMap { $0 }
            + Locale.preferredLanguages
            + [Locale.current.identifier]
            + commonLanguageIdentifiers
        var selected: [String] = []

        for preferredIdentifier in preferredIdentifiers {
            guard selected.count < 14, let match = bestSupportedLocale(for: preferredIdentifier, in: supportedLocales) else { continue }
            if !selected.contains(match.identifier) {
                selected.append(match.identifier)
            }
        }

        if let english = bestSupportedLocale(for: "en-US", in: supportedLocales), !selected.contains(english.identifier) {
            selected.append(english.identifier)
        }

        return selected
    }

    private func languageCode(forLocaleIdentifier identifier: String) -> String {
        Locale(identifier: identifier).language.languageCode?.identifier ?? "en"
    }

    private func displayName(for locale: Locale) -> String {
        let code = locale.language.languageCode?.identifier ?? locale.identifier
        return Locale.current.localizedString(forLanguageCode: code) ?? code.uppercased()
    }

    private func bestSupportedLocale(for identifier: String, in supportedLocales: [Locale]) -> Locale? {
        let normalizedIdentifier = identifier.replacingOccurrences(of: "_", with: "-").lowercased()
        if let exact = supportedLocales.first(where: {
            $0.identifier.replacingOccurrences(of: "_", with: "-").lowercased() == normalizedIdentifier
        }) {
            return exact
        }

        let preferredLocale = Locale(identifier: identifier)
        guard let languageCode = preferredLocale.language.languageCode?.identifier else { return nil }
        let regionCode = preferredLocale.region?.identifier
        return supportedLocales.first(where: {
            $0.language.languageCode?.identifier == languageCode && (regionCode == nil || $0.region?.identifier == regionCode)
        }) ?? supportedLocales.first(where: { $0.language.languageCode?.identifier == languageCode })
    }

    private func restartRecognitionSession() {
        guard shouldKeepListening else { return }
        statusText = "Voice ready."
        restartWorkItem?.cancel()
        sessionRefreshWorkItem?.cancel()
        sessionRefreshWorkItem = nil
        let workItem = DispatchWorkItem { [weak self] in
            self?.startRecognitionSession()
        }
        restartWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: workItem)
    }

    private func scheduleRecognitionSessionRefresh() {
        sessionRefreshWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.shouldKeepListening else { return }
            self.restartRecognitionSession()
        }
        sessionRefreshWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 50, execute: workItem)
    }

    private func stopRecognitionSession(deactivateAudio: Bool) {
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        activeRecognizer = nil
    }
#endif
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = StorePurchaseManager()
    @State private var screen: AppScreen
    @State private var profile: UserProfile
    @State private var preferences: AppPreferences
    @State private var initialScreen: AppScreen
    @State private var selectedListener = AICompanionCatalog.defaultListeners[0]
    @State private var showPaywall = false
    @State private var showCheckoutOverlay = false
    @State private var showCoinStoreOverlay = false
    @State private var checkoutReturnScreen: AppScreen = .lobby
    @State private var coinStoreReturnScreen: AppScreen = .lobby
    @State private var liveSummaryVideo: SavedLiveVideo?
    @State private var showCameraSettingsAlert = false
    @State private var showVoiceSettingsAlert = false

    private var selectedAIListeners: [Listener] {
        let listeners = AICompanionCatalog.listeners(for: profile.avatars)
        return listeners.isEmpty ? AICompanionCatalog.defaultListeners : listeners
    }

    init() {
        let savedProfile = PersistenceStore.loadProfile()
        let savedListeners = AICompanionCatalog.listeners(for: savedProfile.avatars)
        _profile = State(initialValue: savedProfile)
        _preferences = State(initialValue: PersistenceStore.loadPreferences())
        _initialScreen = State(initialValue: savedProfile.isComplete ? .lobby : .onboarding)
        _screen = State(initialValue: .splash)
        _selectedListener = State(initialValue: savedListeners.first ?? AICompanionCatalog.defaultListeners[0])
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
                    SquadLiveAnalytics.log("onboarding_profile_completed")
                    profile.name = name
                    profile.age = age
                    profile.pronoun = pronoun
                    profile.mood = mood
                    PersistenceStore.saveProfile(profile)
                    withAnimation(.easeInOut) { screen = .avatars }
                }
            case .avatars:
                AvatarSelectionView(pronoun: profile.pronoun) { avatars in
                    SquadLiveAnalytics.log("onboarding_avatars_selected", parameters: ["count": avatars.count])
                    profile.avatars = avatars
                    selectedListener = AICompanionCatalog.listeners(for: avatars).first ?? AICompanionCatalog.defaultListeners[0]
                    PersistenceStore.saveProfile(profile)
                    withAnimation(.easeInOut) { screen = .permissions }
                }
            case .permissions:
                PermissionsView(
                    onContinue: {
                        SquadLiveAnalytics.log("permissions_completed", parameters: ["choice": "continue"])
                        withAnimation(.easeInOut) { screen = .lobby }
                    }
                )
            case .lobby:
                LobbyView(
                    userName: profile.name.isEmpty ? "Friend" : profile.name,
                    userAvatarData: profile.userAvatarData,
                    listeners: selectedAIListeners,
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
                    startLiveSessionIfCameraAvailable()
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
                AllListenersView(listeners: selectedAIListeners, selectedListener: $selectedListener) {
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
                    listeners: selectedAIListeners,
                    userName: profile.name.isEmpty ? "Friend" : profile.name,
                    userAvatarData: profile.userAvatarData,
                    preferences: $preferences,
                    initialPopularity: Self.liveBasePopularity(for: preferences),
                    purchasedAudienceCount: Self.purchasedAudienceBoost(for: preferences),
                    audienceArrivalMinutes: preferences.lobbyArriveTime,
                    showPaywall: $showPaywall,
                    onEnd: { summary in
                        SquadLiveAnalytics.log("live_ended", parameters: [
                            "duration_seconds": Int(summary.duration),
                            "peak_viewers": summary.peakViewers,
                            "comments": summary.comments,
                            "gifts": summary.gifts,
                            "likes": summary.likes,
                            "membership_tier": preferences.isPremiumMember ? "pro" : "free"
                        ])
                        liveSummaryVideo = saveFinishedLiveVideo(summary)
                        withAnimation(.easeInOut) { screen = .liveSummary }
                    },
                    onStartFailureExit: {
                        showPaywall = false
                        withAnimation(.easeInOut) { screen = .lobby }
                    },
                    onShowCoinStore: { openCoinStore(from: .live) },
                    onUpgrade: { openCheckout(from: .live) },
                    onCoinsChanged: { updatedCoins in
                        preferences.coins = updatedCoins
                    },
                    onRequestReview: {
                        AppReviewStrategy.requestFromLive(preferences: &preferences)
                    }
                )
            case .liveSummary:
                if let liveSummaryVideo {
                    LiveSummaryView(video: liveSummaryVideo) {
                        self.liveSummaryVideo = nil
                        withAnimation(.easeInOut) { screen = .lobby }
                    }
                } else {
                    Color.clear
                        .task { screen = .lobby }
                }
            case .coinStore:
                CoinStoreView(
                    store: store,
                    coins: preferences.coins,
                    onClose: {
                        withAnimation(.easeInOut) { screen = coinStoreReturnScreen }
                    }
                )
            case .checkout:
                PremiumCheckoutView(
                    store: store,
                    onClose: {
                        showPaywall = checkoutReturnScreen == .live
                        withAnimation(.easeInOut) { screen = checkoutReturnScreen }
                    },
                    onSubscribe: {
                        showPaywall = false
                        preferences.isPremiumMember = true
                        PersistenceStore.savePreferences(preferences)
                        withAnimation(.easeInOut) { screen = checkoutReturnScreen }
                    }
                )
            }

            if showCheckoutOverlay {
                PremiumCheckoutView(
                    store: store,
                    onClose: {
                        showPaywall = false
                        withAnimation(.easeInOut) { showCheckoutOverlay = false }
                    },
                    onSubscribe: {
                        showPaywall = false
                        preferences.isPremiumMember = true
                        PersistenceStore.savePreferences(preferences)
                        withAnimation(.easeInOut) { showCheckoutOverlay = false }
                    }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .zIndex(10)
            }

            if showCoinStoreOverlay {
                CoinStoreView(
                    store: store,
                    coins: preferences.coins,
                    onClose: {
                        withAnimation(.easeInOut) { showCoinStoreOverlay = false }
                    }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .zIndex(11)
            }
        }
        .preferredColorScheme(.dark)
        .task {
#if os(iOS)
            RemoteImageCache.prefetch(urlStrings: AICompanionCatalog.friends.map(\.imageURL))
#endif
            Task(priority: .utility) {
                await DeepSeekClient.warmBackend()
            }
            store.setCoinGrantHandler { grant in
                let transactionID = String(grant.id)
                if preferences.appliedCoinTransactionIDs.contains(transactionID) {
                    preferences.coins = grant.balance
                    PersistenceStore.savePreferences(preferences)
                    return
                }
                preferences.coins = grant.balance
                preferences.appliedCoinTransactionIDs.append(String(grant.id))
                if preferences.appliedCoinTransactionIDs.count > 500 {
                    preferences.appliedCoinTransactionIDs.removeFirst(preferences.appliedCoinTransactionIDs.count - 500)
                }
                PersistenceStore.savePreferences(preferences)
            }
            if let walletUser = await StoreBackendClient.fetchWalletStateWithRetry() {
                preferences.coins = walletUser.coins
                if let firstLiveFreeAvailable = walletUser.firstLiveFreeAvailable {
                    preferences.hasStartedLiveSession = !firstLiveFreeAvailable
                } else if let liveSessionsStarted = walletUser.liveSessionsStarted {
                    preferences.hasStartedLiveSession = liveSessionsStarted > 0
                }
                PersistenceStore.savePreferences(preferences)
                SquadLiveAnalytics.setCoinBalance(walletUser.coins)
            }
            await store.start()
        }
        .onChange(of: profile) { _, newValue in
            PersistenceStore.saveProfile(newValue)
        }
        .onChange(of: preferences) { _, newValue in
            PersistenceStore.savePreferences(newValue)
        }
        .onChange(of: preferences.coins) { _, newValue in
            SquadLiveAnalytics.setCoinBalance(newValue)
        }
        .onChange(of: store.isPremium) { _, isPremium in
            guard store.didLoadEntitlements else { return }
            preferences.isPremiumMember = isPremium
            PersistenceStore.savePreferences(preferences)
            SquadLiveAnalytics.setPremium(isPremium)
        }
        .onChange(of: store.didLoadEntitlements) { _, didLoad in
            guard didLoad else { return }
            preferences.isPremiumMember = store.isPremium
            PersistenceStore.savePreferences(preferences)
            SquadLiveAnalytics.setPremium(store.isPremium)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                if let walletUser = await StoreBackendClient.fetchWalletState() {
                    preferences.coins = walletUser.coins
                    if let firstLiveFreeAvailable = walletUser.firstLiveFreeAvailable {
                        preferences.hasStartedLiveSession = !firstLiveFreeAvailable
                    } else if let liveSessionsStarted = walletUser.liveSessionsStarted {
                        preferences.hasStartedLiveSession = liveSessionsStarted > 0
                    }
                    PersistenceStore.savePreferences(preferences)
                    SquadLiveAnalytics.setCoinBalance(walletUser.coins)
                }
            }
        }
        .alert("Camera Access Required", isPresented: $showCameraSettingsAlert) {
#if os(iOS)
            Button("Open Settings") {
                guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(settingsURL)
            }
#endif
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Camera access is required to use the live session feature. Please enable camera access in Settings.")
        }
        .alert("Voice Access Unavailable", isPresented: $showVoiceSettingsAlert) {
#if os(iOS)
            Button("Open Settings") {
                guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(settingsURL)
            }
#endif
            Button("Continue Without Voice") {
                beginLiveSession()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The camera can still work, but AI friends cannot hear you until Microphone and Speech Recognition access are enabled. You can continue and use text prompts instead.")
        }
    }

    private func startLiveSessionIfCameraAvailable() {
#if os(iOS)
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            continueLiveSessionAfterCameraCheck()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted {
                        continueLiveSessionAfterCameraCheck()
                    } else {
                        reportLivePreflightFailure("camera_permission_denied")
                        showCameraSettingsAlert = true
                    }
                }
            }
        case .denied, .restricted:
            reportLivePreflightFailure("camera_permission_denied")
            showCameraSettingsAlert = true
        @unknown default:
            reportLivePreflightFailure("camera_permission_unknown")
            showCameraSettingsAlert = true
        }
#else
        beginLiveSession()
#endif
    }

    private func reportLivePreflightFailure(_ reason: String) {
        SquadLiveAnalytics.log("live_start_preflight_failed", parameters: ["reason": reason])
        Task {
            await LiveEngagementClient.report(
                type: "live_start_failed",
                sessionId: UUID(),
                reason: reason
            )
        }
    }

#if os(iOS)
    private func continueLiveSessionAfterCameraCheck() {
        let microphoneStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        if microphoneStatus == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async {
                    continueLiveSessionAfterCameraCheck()
                }
            }
            return
        }

        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { _ in
                DispatchQueue.main.async {
                    continueLiveSessionAfterCameraCheck()
                }
            }
            return
        }

        if microphoneStatus == .denied || microphoneStatus == .restricted || speechStatus == .denied || speechStatus == .restricted {
            showVoiceSettingsAlert = true
            return
        }
        beginLiveSession()
    }
#endif

    private func beginLiveSession() {
        showPaywall = false
        SquadLiveAnalytics.log("live_started", parameters: [
            "membership_tier": preferences.isPremiumMember ? "pro" : "free",
            "audience_setting": preferences.lobbyJoinCount,
            "coins": preferences.coins
        ])
        withAnimation(.easeInOut) { screen = .live }
    }

    private func saveFinishedLiveVideo(_ summary: LiveSessionSummary) -> SavedLiveVideo {
        let id = UUID()
        let filename = LiveRecordingStore.persistTemporaryRecording(summary.recordingURL, id: id)
        let video = SavedLiveVideo(
            id: id,
            durationSeconds: max(summary.duration, 1),
            peakPopularity: summary.peakViewers,
            localVideoFilename: filename,
            likes: summary.likes,
            commentCount: summary.comments,
            giftCount: summary.gifts
        )
        preferences.savedVideos.insert(video, at: 0)
        preferences.savedVideos = Array(preferences.savedVideos.prefix(20))
        preferences.completedLiveSessions += 1
        preferences.reviewPositiveMoments += summary.duration >= 12 ? 2 : 1
        PersistenceStore.savePreferences(preferences)
        return video
    }

    private static func liveBasePopularity(for preferences: AppPreferences) -> Int {
        if preferences.isPremiumMember {
            return Int.random(in: 9_000...12_000)
        }
        return Int.random(in: 850...1_250)
    }

    private static func purchasedAudienceBoost(for preferences: AppPreferences) -> Int {
        if preferences.selectedViewerPackLabel == nil && preferences.lobbyJoinCount <= 500 {
            return 0
        }
        return max(0, preferences.lobbyJoinCount)
    }

    private func openCheckout(from returnScreen: AppScreen) {
        SquadLiveAnalytics.log("paywall_viewed", parameters: ["source": returnScreen == .live ? "live" : "lobby"])
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
        SquadLiveAnalytics.log("coin_store_viewed", parameters: ["source": returnScreen == .live ? "live" : "lobby"])
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

                Text("🔒 AI-only room. No real human viewers.")
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

                        Text("Pick 1–3 AI friends. They take turns naturally depending on what you need.")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(.white.opacity(0.58))
                            .lineSpacing(5)
                    }
                    .padding(.top, 32)

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 3), spacing: 16) {
                        ForEach(AICompanionCatalog.friends) { friend in
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
    let gender: AICompanionGender
    let replyStyle: String
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
                    RemoteImage(urlString: friend.imageURL, placeholderText: friend.emoji)
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
                        Text("\(friend.gender.label) · \(friend.replyStyle)")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.white.opacity(0.46))
                            .lineLimit(1)
                            .minimumScaleFactor(0.66)
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
                    Text(selected.isEmpty ? "Choose 1–3 AI friends" : selected.map(\.name).joined(separator: ", "))
                        .font(.system(size: 16, weight: .black))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(selected.isEmpty ? "Pick at least 1 to continue" : "will be in your stream 💜")
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
                    Text(selected.isEmpty ? "Select at least 1 friend" : "Continue with \(selected.count) friend\(selected.count == 1 ? "" : "s")")
                    if !selected.isEmpty {
                        Image(systemName: "arrow.right")
                    }
                }
                .font(.system(size: 17, weight: .black))
                .foregroundStyle(selected.isEmpty ? .white.opacity(0.42) : .white)
                .frame(maxWidth: .infinity)
                .frame(height: 60)
                .background(selected.isEmpty ? .white.opacity(0.10) : Color.brandPurple, in: RoundedRectangle(cornerRadius: 18))
                .shadow(color: selected.isEmpty ? .clear : .brandPurple.opacity(0.38), radius: 20)
            }
            .disabled(selected.isEmpty)
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
    let onContinue: () -> Void
    @State private var isRequesting = false

    private let permissions = [
        ("camera.fill", "Camera Access", "This lets you interact with your AI audience and record your live session locally for sharing. Recordings stay on your device unless you choose to share them."),
        ("mic.fill", "Microphone", "By enabling microphone access, you can chat with your AI fans naturally through voice."),
        ("dot.radiowaves.left.and.right", "Voice Understanding", "Your speech is transcribed for AI replies. If you save a live recording, its audio remains on your device unless you choose to share it."),
        ("bell.fill", "Notifications", "Notifications can remind you when it may be a good time to start another live session. You can manage notifications in Settings at any time.")
    ]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Set Up Your Live Session")
                            .font(.system(size: 28, weight: .bold))
                            .foregroundStyle(.white)
                        HStack(spacing: 8) {
                            Circle().fill(Color.brandPurple).frame(width: 8, height: 8)
                            Text("Privacy First")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.brandPurple)
                        }
                        Text("SquadLive is an AI-only live experience with no real human viewers. Camera scene analysis runs on your device; conversation text and limited scene context are sent to the AI service to generate replies. Saved recordings remain on your device unless you share them.")
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

            VStack {
                PrimaryButton(title: isRequesting ? "Continuing..." : "Continue") {
                    requestPermissions()
                }
                .disabled(isRequesting)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 28)
        }
    }

    private func requestPermissions() {
        isRequesting = true
        AVCaptureDevice.requestAccess(for: .video) { _ in
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                SFSpeechRecognizer.requestAuthorization { _ in
                    PromotionNotificationManager.requestAuthorizationIfNeeded {
                        DispatchQueue.main.async {
                            isRequesting = false
                            onContinue()
                        }
                    }
                }
            }
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
    @State private var coinChargeAlertTitle = "Not enough coins"
    @State private var coinChargeAlertMessage: String?
    @State private var showLowAudienceWarning = false
    @State private var isChargingViewerPack = false
    @State private var countdown = 3
    @State private var countdownTimer: Timer?
    @State private var rewardVideoID: UUID?
    @State private var rewardPlatform = "TikTok"
    @State private var rewardProofLink = ""
    @State private var rewardScreenshotData: Data?
    @State private var savedVideoMessage: String?
    @State private var isSubmittingReward = false
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
        .alert(coinChargeAlertTitle, isPresented: $showCoinRechargeAlert) {
            if coinChargeAlertTitle == "Not enough coins" {
                Button("Recharge Coins", action: onShowCoinStore)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(coinChargeAlertMessage ?? insufficientCoinsMessage)
        }
        .alert("Your audience may become quieter", isPresented: $showLowAudienceWarning) {
            Button("Add AI Friends", action: onSeeAll)
            Button("Keep 50 Viewers", role: .cancel) {}
        } message: {
            Text("With 50 viewers selected, fewer AI viewers may remain later in longer live sessions. You can add AI friends in settings for a more active room.")
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
                Text("SQUADLIVE")
                    .font(.system(size: 15, weight: .black))
                    .foregroundStyle(.white)
                Circle().fill(Color.red).frame(width: 7, height: 7)
            }

            Spacer()

            Button(action: onShowVIP) {
                HStack(spacing: 6) {
                    Image(systemName: "crown.fill")
                        .foregroundStyle(Color.gold)
                    Text("PRO")
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
                Text(preferences.selectedVibes.contains("Hater")
                     ? "Enable skeptical audience mode during your live session"
                     : "Set the audience mood during your live session")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.82))
                Text(preferences.selectedVibes.contains("Hater")
                     ? "Haters will challenge your takes with skeptical comments"
                     : "Choose one or more audience moods to shape the vibe · \(preferences.selectedVibes.count) selected")
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

            Text("Your AI audience grows quickly toward \(baseViewerCount.formatted()) viewers after you go live. \(purchasedViewerBoost.formatted()) extra viewers will join within \(Int(preferences.lobbyArriveTime)) minute\(preferences.lobbyArriveTime == 1 ? "" : "s").")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white.opacity(0.62))
                .multilineTextAlignment(.center)

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                ForEach(viewerPacks, id: \.label) { pack in
                    let canAfford = isFirstLiveFreePreview || preferences.coins >= pack.cost
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
                                Text(isFirstLiveFreePreview ? "Free" : "\(pack.cost)")
                                    .font(.system(size: 12, weight: .bold))
                            }
                            .foregroundStyle(canAfford ? Color.gold : Color.red.opacity(0.85))
                            .opacity(canAfford ? 1 : 0.58)

                            Text(isSelected ? "Selected" : (isFirstLiveFreePreview ? "First live free" : (canAfford ? "Pay on Start" : "Need coins")))
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
                    Text("\(purchasedViewerBoost.formatted()) extra AI viewers selected")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                    Spacer()
                    Text(isFirstLiveFreePreview ? "First live free · normally \(selectedViewerCost) coins" : "\(selectedViewerCost) coins charged when live starts")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(isFirstLiveFreePreview || preferences.coins >= selectedViewerCost ? .white.opacity(0.56) : Color.red.opacity(0.86))
                }
                .padding(14)
                .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.10)))
            }

            SliderBlock(title: "Viewer arrive time", value: $preferences.lobbyArriveTime, range: 1...60, step: 1, valueText: "\(Int(preferences.lobbyArriveTime)) min", minText: "1 min", maxText: "1 hr")
            SliderBlock(
                title: "How many extra AI viewers join",
                value: Binding(
                    get: { Double(preferences.lobbyJoinCount) },
                    set: { value in
                        let viewerCount = Int(value)
                        let shouldWarn = viewerCount == 50 && preferences.lobbyJoinCount != 50
                        preferences.lobbyJoinCount = viewerCount
                        preferences.selectedViewerPackLabel = matchingViewerPackLabel(for: viewerCount)
                        if shouldWarn {
                            showLowAudienceWarning = true
                        }
                    }
                ),
                range: 50...500000,
                step: 50,
                valueText: isFirstLiveFreePreview
                    ? "\(preferences.lobbyJoinCount.formatted()) · First live free"
                    : "\(preferences.lobbyJoinCount.formatted()) · \(selectedViewerCost) coins",
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
                        Text("Submit a social share link or screenshot to receive a 100-coin daily bonus. One bonus is available per day.")
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.62))
                            .lineSpacing(2)
                    }
                }

                HStack(spacing: 10) {
                    RewardRulePill(icon: "bolt.fill", title: "Daily submit", coins: "100")
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
                    EmptyStateCard(title: "No saved streams", message: "End a live session to create a recorded video you can save or share.")
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
                Task { await submitRewardProof(for: video) }
            } label: {
                HStack {
                    Image(systemName: "paperplane.fill")
                    Text(isSubmittingReward ? "Submitting securely..." : "Submit for review")
                }
                .font(.system(size: 15, weight: .black))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(canSubmitRewardProof ? Color.green : .white.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
            }
            .disabled(!canSubmitRewardProof || isSubmittingReward)
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
        guard let videoURL = LiveRecordingStore.url(for: video.localVideoFilename) else {
            savedVideoMessage = "This older stream has no video recording. Start a new live session to create a shareable video."
            return
        }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async {
                    savedVideoMessage = "Photo access is needed to save locally."
                }
                return
            }

            PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: videoURL)
            } completionHandler: { success, _ in
                DispatchQueue.main.async {
                    if success {
                        markSavedVideoDownloaded(video.id)
                        savedVideoMessage = "Live video saved to Photos and ready to share."
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

    private var baseViewerCount: Int {
        preferences.isPremiumMember ? 200_000 : 20_000
    }

    private var purchasedViewerBoost: Int {
        if preferences.selectedViewerPackLabel == nil && preferences.lobbyJoinCount <= 500 {
            return 0
        }
        return max(0, preferences.lobbyJoinCount)
    }

    private var selectedViewerCost: Int {
        viewerCost(for: preferences.lobbyJoinCount)
    }

    private var isFirstLiveFreePreview: Bool {
        !preferences.hasStartedLiveSession && preferences.completedLiveSessions == 0
    }

    private var insufficientCoinsMessage: String {
        "\(purchasedViewerBoost.formatted()) extra AI viewers cost \(selectedViewerCost) coins. You currently have \(preferences.coins) coins."
    }

    private var bottomBar: some View {
        HStack(alignment: .center) {
            Button {
                activeTab = .saved
                rewardVideoID = preferences.savedVideos.first?.id
            } label: {
                HStack(spacing: 8) {
                    CoinIcon(size: 20)
                    Text("Earn daily coins by sharing")
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
        if id == "Hater" {
            preferences.selectedVibes = preferences.selectedVibes == [id] ? ["Fan"] : [id]
            return
        }
        preferences.selectedVibes.removeAll { $0 == "Hater" }
        if preferences.selectedVibes.contains(id) {
            preferences.selectedVibes.removeAll { $0 == id }
            if preferences.selectedVibes.isEmpty {
                preferences.selectedVibes = ["Fan"]
            }
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
        guard !isChargingViewerPack else { return }

        isChargingViewerPack = true
        let selectedViewers = preferences.lobbyJoinCount
        let operationId: UUID
        if preferences.pendingLobbyAudienceViewers == selectedViewers,
           let rawOperationID = preferences.pendingLobbyAudienceOperationID,
           let pendingOperationID = UUID(uuidString: rawOperationID) {
            operationId = pendingOperationID
        } else {
            operationId = UUID()
            preferences.pendingLobbyAudienceOperationID = operationId.uuidString
            preferences.pendingLobbyAudienceViewers = selectedViewers
            PersistenceStore.savePreferences(preferences)
        }
        Task { @MainActor in
            let result = await StoreBackendClient.commitAudiencePurchase(
                viewers: selectedViewers,
                context: "lobby",
                operationId: operationId
            )
            isChargingViewerPack = false
            switch result {
            case .success(let balance, let chargedCost, let regularCost, let firstLiveFree):
                SquadLiveAnalytics.log("audience_purchase_completed", parameters: [
                    "viewers": selectedViewers,
                    "context": "lobby",
                    "balance": balance,
                    "charged_coins": chargedCost,
                    "regular_coins": regularCost,
                    "first_live_free": firstLiveFree
                ])
                preferences.coins = balance
                preferences.hasStartedLiveSession = true
                preferences.selectedViewerPackLabel = nil
                PersistenceStore.savePreferences(preferences)
                beginCountdown()
            case .insufficient(let balance):
                SquadLiveAnalytics.log("audience_purchase_failed", parameters: [
                    "viewers": selectedViewers,
                    "context": "lobby",
                    "reason": "insufficient_coins",
                    "balance": balance
                ])
                preferences.pendingLobbyAudienceOperationID = nil
                preferences.pendingLobbyAudienceViewers = nil
                preferences.coins = balance
                coinChargeAlertTitle = "Not enough coins"
                coinChargeAlertMessage = nil
                showCoinRechargeAlert = true
            case .unavailable:
                SquadLiveAnalytics.log("audience_purchase_failed", parameters: [
                    "viewers": selectedViewers,
                    "context": "lobby",
                    "reason": "server_unavailable"
                ])
                Task {
                    await LiveEngagementClient.report(
                        type: "live_start_failed",
                        sessionId: UUID(),
                        reason: "audience_verification_unavailable"
                    )
                }
                coinChargeAlertTitle = "Unable to verify coins"
                coinChargeAlertMessage = "Please check your connection and try again. No coins were charged."
                showCoinRechargeAlert = true
            }
        }
    }

    private func beginCountdown() {
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

    private func submitRewardProof(for video: SavedLiveVideo) async {
        guard !isSubmittingReward else { return }
        let cleanLink = rewardProofLink.trimmingCharacters(in: .whitespacesAndNewlines)
        isSubmittingReward = true
        defer { isSubmittingReward = false }
        let submission = RewardSubmission(
            videoID: video.id,
            platform: rewardPlatform,
            proofLink: cleanLink,
            screenshotData: rewardScreenshotData,
            estimatedRewardCoins: 0
        )

        guard let response = await StoreBackendClient.submitShareReward(
            operationId: submission.id,
            platform: rewardPlatform,
            proofLink: cleanLink,
            screenshotData: rewardScreenshotData
        ) else {
            savedVideoMessage = "Unable to submit securely. Please check your connection and try again."
            return
        }

        var savedSubmission = submission
        savedSubmission.estimatedRewardCoins = response.submission?.baseRewardCoins ?? 0
        preferences.coins = response.user.coins
        preferences.rewardSubmissions.insert(savedSubmission, at: 0)
        preferences.rewardSubmissions = Array(preferences.rewardSubmissions.prefix(50))
        savedVideoMessage = savedSubmission.estimatedRewardCoins > 0
            ? "Share submitted. 100 coins added for today's daily bonus."
            : "Share submitted. Daily 100 coin bonus already claimed today."
        rewardProofLink = ""
        rewardScreenshotData = nil
#if os(iOS)
        selectedRewardScreenshot = nil
#endif
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
    @ObservedObject var store: StorePurchaseManager
    let coins: Int
    let onClose: () -> Void
    @State private var purchaseMessage: String?
    @State private var selectedPackCoins = 525
    @State private var showCoinAddedConfirmation = false
    @State private var synchronizedCoinAmount = 0

    private let packs = [
        (id: StoreProductID.coin330, coins: 330, rate: "66.1 coins/$1", bonus: nil as String?, badge: nil as String?, price: "$4.99", highlighted: false),
        (id: StoreProductID.coin420, coins: 420, rate: "70.1 coins/$1", bonus: "+6% bonus", badge: nil, price: "$5.99", highlighted: false),
        (id: StoreProductID.coin525, coins: 525, rate: "75.1 coins/$1", bonus: "+14% bonus", badge: "Great Value", price: "$6.99", highlighted: true),
        (id: StoreProductID.coin740, coins: 740, rate: "82.3 coins/$1", bonus: "+24% bonus", badge: nil, price: "$8.99", highlighted: false),
        (id: StoreProductID.coin1450, coins: 1_450, rate: "96.7 coins/$1", bonus: "+46% bonus", badge: "Best Value", price: "$14.99", highlighted: false),
        (id: StoreProductID.coin1800, coins: 1_800, rate: "90.0 coins/$1", bonus: "+36% bonus", badge: "Most Coins", price: "$19.99", highlighted: false)
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
                        ForEach(packs, id: \.id) { pack in
                            CoinStorePackRow(
                                coins: pack.coins,
                                rate: pack.rate,
                                bonus: pack.bonus,
                                badge: pack.badge,
                                price: store.product(for: pack.id)?.displayPrice ?? pack.price,
                                highlighted: pack.highlighted,
                                isSelected: selectedPackCoins == pack.coins
                            ) {
                                selectedPackCoins = pack.coins
                                Task {
                                    purchaseMessage = nil
                                    let purchased = await store.purchase(productID: pack.id)
                                    guard purchased else {
                                        purchaseMessage = store.statusMessage
                                        return
                                    }

                                    synchronizedCoinAmount = pack.coins
                                    await Task.yield()
                                    withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) {
                                        showCoinAddedConfirmation = true
                                    }
                                    purchaseMessage = "+\(pack.coins.formatted()) coins added."
                                    try? await Task.sleep(for: .milliseconds(950))
                                    withAnimation(.easeOut(duration: 0.22)) {
                                        showCoinAddedConfirmation = false
                                    }
                                }
                            }
                            .disabled(store.purchasingProductID != nil || showCoinAddedConfirmation)
                        }

                        if let purchaseMessage {
                            Text(purchaseMessage)
                                .font(.system(size: 14, weight: .black))
                                .foregroundStyle(purchaseMessage.contains("added") ? Color.green : Color.gold)
                                .frame(maxWidth: .infinity)
                                .frame(height: 38)
                                .background(.white.opacity(0.07), in: Capsule())
                        }

                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "bolt.fill")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(Color.gold)
                            Text("Coins are added after App Store verification. Refund requests are handled by Apple under App Store policies.")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(.white.opacity(0.32))
                                .lineSpacing(3)
                            Spacer()
                        }
                        .padding(.top, 8)

                        HStack(spacing: 20) {
                            Link("Privacy Policy", destination: SquadLiveLegalLinks.privacy)
                            Link("Terms of Use", destination: SquadLiveLegalLinks.terms)
                        }
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white.opacity(0.48))
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

            if store.purchasingProductID != nil || showCoinAddedConfirmation {
                Color.black.opacity(0.58)
                    .ignoresSafeArea()
                    .transition(.opacity)
                    .zIndex(10)

                VStack(spacing: 16) {
                    if store.purchasingProductID != nil {
                        ProgressView()
                            .tint(.white)
                            .scaleEffect(1.2)
                        Text("Confirming your purchase...")
                            .font(.system(size: 19, weight: .black))
                            .foregroundStyle(.white)
                        Text("Please wait while the App Store verifies the transaction.")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(.white.opacity(0.58))
                            .multilineTextAlignment(.center)
                    } else {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 58, weight: .bold))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, Color.green)
                        Text("+\(synchronizedCoinAmount.formatted()) Coins Added")
                            .font(.system(size: 21, weight: .black))
                            .foregroundStyle(.white)
                        Text("Current balance: \(coins.formatted())")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Color.gold)
                    }
                }
                .padding(.horizontal, 28)
                .frame(width: 300, height: 210)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26))
                .overlay(RoundedRectangle(cornerRadius: 26).stroke(.white.opacity(0.16)))
                .shadow(color: .black.opacity(0.48), radius: 30)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.opacity.combined(with: .scale(scale: 0.94)))
                .zIndex(11)
            }
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
            HStack(spacing: 12) {
                CoinIcon(size: 34)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(coins.formatted())
                            .font(.system(size: 24, weight: .black))
                            .foregroundStyle(isSelected && highlighted ? Color(red: 1.0, green: 0.57, blue: 0.36) : Color.gold)
                        if let badge {
                            Text(badge.uppercased())
                                .font(.system(size: 8, weight: .black))
                                .foregroundStyle(badgeColor)
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                                .padding(.horizontal, 7)
                                .frame(height: 18)
                                .background(badgeColor.opacity(0.13), in: Capsule())
                                .overlay(Capsule().stroke(badgeColor.opacity(0.48), lineWidth: 1))
                        }
                    }
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
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity)
            .frame(height: 84)
            .background(rowBackground, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(borderColor, lineWidth: isSelected ? 2 : 1))
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

                Text(video.localVideoFilename == nil ? "Legacy record · no playable video" : (video.downloadedAt == nil ? "Ready to save and share" : "Saved to Photos"))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(video.localVideoFilename == nil ? Color.gold : (video.downloadedAt == nil ? .white.opacity(0.46) : Color.green))

                Text(hasSubmission ? "Proof submitted" : "Ready for TikTok or Instagram reward proof")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(hasSubmission ? Color.green : Color.gold)
            }

            Spacer()

            VStack(spacing: 10) {
                if let videoURL = LiveRecordingStore.url(for: video.localVideoFilename) {
                    ShareLink(item: videoURL) {
                        Image(systemName: "square.and.arrow.up.circle.fill")
                            .font(.system(size: 22, weight: .bold))
                            .foregroundStyle(Color.gold)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .contentShape(Rectangle())
                }

                Button(action: onDownload) {
                    Image(systemName: video.downloadedAt == nil ? "arrow.down.circle.fill" : "checkmark.circle.fill")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(video.downloadedAt == nil ? Color.brandPurple : Color.green)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())

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
                Text(submission.estimatedRewardCoins > 0 ? "+\(submission.estimatedRewardCoins.formatted()) daily bonus coins" : "Share proof saved")
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

private struct LiveSummaryView: View {
    let video: SavedLiveVideo
    let onDone: () -> Void

    @State private var saveMessage: String?
    @State private var isSaving = false
    @State private var isPreparingShare = false
    @State private var clipStart = 0.0
    @State private var clipEnd = 1.0
    @State private var shareItem: LiveClipShareItem?

    private var videoURL: URL? {
        LiveRecordingStore.url(for: video.localVideoFilename)
    }

    private var likes: Int {
        max(video.likes ?? 0, 0)
    }

    private var comments: Int {
        max(video.commentCount ?? 0, 0)
    }

    private var gifts: Int {
        max(video.giftCount ?? 0, 0)
    }

    private var minimumClipFraction: Double {
        min(0.25, max(0.015, 1 / Double(max(video.durationSeconds, 1))))
    }

    private var clipStartSeconds: Double {
        Double(video.durationSeconds) * clipStart
    }

    private var clipEndSeconds: Double {
        Double(video.durationSeconds) * clipEnd
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.08, green: 0.05, blue: 0.16), .black, Color(red: 0.04, green: 0.03, blue: 0.08)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            Circle()
                .fill(Color.brandPurple.opacity(0.24))
                .frame(width: 320, height: 320)
                .blur(radius: 70)
                .offset(x: -150, y: -340)

            Circle()
                .fill(Color.pink.opacity(0.18))
                .frame(width: 280, height: 280)
                .blur(radius: 80)
                .offset(x: 170, y: 360)

            ScrollView(showsIndicators: false) {
                VStack(spacing: 22) {
                    VStack(spacing: 7) {
                        Text("LIVE COMPLETE")
                            .font(.system(size: 12, weight: .black))
                            .tracking(2.2)
                            .foregroundStyle(Color.brandPurple)
                        Text("Live Summary")
                            .font(.system(size: 34, weight: .black))
                            .foregroundStyle(.white)
                        Text("Your room showed up for you.")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.54))
                    }
                    .padding(.top, 18)

                    HStack(spacing: 10) {
                        summaryStat(icon: "eye.fill", value: compactNumber(video.peakPopularity), title: "Viewers")
                        summaryStat(icon: "heart.fill", value: compactNumber(likes), title: "Likes")
                        summaryStat(icon: "bubble.left.fill", value: compactNumber(comments), title: "Comments")
                    }

                    VStack(spacing: 20) {
                        VStack(spacing: 7) {
                            Label("PEAK VIEWERS", systemImage: "person.2.fill")
                                .font(.system(size: 12, weight: .black))
                                .tracking(1.2)
                                .foregroundStyle(.white.opacity(0.64))
                            Text(compactNumber(video.peakPopularity))
                                .font(.system(size: 64, weight: .black, design: .rounded))
                                .minimumScaleFactor(0.65)
                                .foregroundStyle(.white)
                                .shadow(color: Color.brandPurple.opacity(0.65), radius: 24)
                        }

                        HStack(spacing: 0) {
                            recapStat(icon: "heart.fill", value: compactNumber(likes), title: "LIKES")
                            recapStat(icon: "bubble.left.fill", value: compactNumber(comments), title: "COMMENTS")
                            recapStat(icon: "gift.fill", value: compactNumber(gifts), title: "GIFTS")
                        }
                    }
                    .padding(.vertical, 30)
                    .padding(.horizontal, 18)
                    .background {
                        RoundedRectangle(cornerRadius: 28, style: .continuous)
                            .fill(LinearGradient(colors: [Color.brandPurple.opacity(0.78), Color.pink.opacity(0.40), Color(red: 0.20, green: 0.05, blue: 0.30)], startPoint: .topLeading, endPoint: .bottomTrailing))
                            .overlay(RoundedRectangle(cornerRadius: 28).stroke(.white.opacity(0.18)))
                    }
                    .shadow(color: Color.brandPurple.opacity(0.30), radius: 30, y: 14)

                    VStack(spacing: 14) {
                        HStack {
                            Label("Shareable clip", systemImage: "scissors")
                            Spacer()
                            Text("\(formatClipTime(clipStartSeconds)) – \(formatClipTime(clipEndSeconds))")
                        }
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white.opacity(0.72))

                        GeometryReader { geometry in
                            let trackWidth = max(geometry.size.width, 1)
                            let handleInset: CGFloat = 15
                            let usableWidth = max(trackWidth - handleInset * 2, 1)
                            let startX = handleInset + usableWidth * CGFloat(clipStart)
                            let endX = handleInset + usableWidth * CGFloat(clipEnd)
                            ZStack(alignment: .leading) {
                                Capsule().fill(.white.opacity(0.12)).frame(height: 7)
                                Capsule()
                                    .fill(LinearGradient(colors: [Color.brandPurple, .pink], startPoint: .leading, endPoint: .trailing))
                                    .frame(width: max(endX - startX, 0), height: 7)
                                    .offset(x: startX)
                                clipHandle
                                    .position(x: startX, y: 12)
                                    .highPriorityGesture(
                                        DragGesture(minimumDistance: 0, coordinateSpace: .named("clipTrack"))
                                            .onChanged { value in
                                                clipStart = min(
                                                    max(Double((value.location.x - handleInset) / usableWidth), 0),
                                                    clipEnd - minimumClipFraction
                                                )
                                            }
                                    )
                                clipHandle
                                    .position(x: endX, y: 12)
                                    .highPriorityGesture(
                                        DragGesture(minimumDistance: 0, coordinateSpace: .named("clipTrack"))
                                            .onChanged { value in
                                                clipEnd = max(
                                                    min(Double((value.location.x - handleInset) / usableWidth), 1),
                                                    clipStart + minimumClipFraction
                                                )
                                            }
                                    )
                            }
                            .coordinateSpace(name: "clipTrack")
                        }
                        .frame(height: 30)

                        Text("Drag both handles to choose the part you want to save or share.")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.42))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(18)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 20))
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(.white.opacity(0.09)))

                    if videoURL == nil {
                        Label(
                            "The full live recording was unavailable. SquadLive did not substitute the raw camera video.",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Color.gold)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(Color.gold.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.gold.opacity(0.28)))
                    }

                    VStack(spacing: 12) {
                        Button(action: shareSelectedClip) {
                            summaryButtonLabel(
                                title: isPreparingShare ? "Preparing Clip..." : "Share Selected Clip",
                                icon: "square.and.arrow.up",
                                isPrimary: true
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(isPreparingShare || isSaving || videoURL == nil)
                        .opacity(videoURL == nil ? 0.48 : 1)

                        Button(action: saveToPhotos) {
                            summaryButtonLabel(
                                title: isSaving ? "Preparing Clip..." : "Save Selected Clip",
                                icon: saveMessage == "Saved to Photos" ? "checkmark.circle.fill" : "arrow.down.to.line",
                                isPrimary: false
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(isSaving || videoURL == nil)

                        if let saveMessage {
                            Text(saveMessage)
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(saveMessage == "Saved to Photos" ? Color.green : .white.opacity(0.58))
                        }

                        Button(action: onDone) {
                            Text("Done")
                                .font(.system(size: 18, weight: .black))
                                .foregroundStyle(.white.opacity(0.78))
                                .frame(maxWidth: .infinity)
                                .frame(height: 60)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 34)
            }
        }
        .preferredColorScheme(.dark)
        .sheet(item: $shareItem) { item in
            LiveClipShareSheet(url: item.url)
        }
    }

    private var clipHandle: some View {
        ZStack {
            Circle()
                .fill(.white)
                .frame(width: 30, height: 30)
                .shadow(color: .black.opacity(0.32), radius: 7, y: 3)
            Capsule()
                .fill(Color.brandPurple)
                .frame(width: 4, height: 14)
        }
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }

    private func summaryStat(icon: String, value: String, title: String) -> some View {
        VStack(spacing: 7) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(Color.brandPurple)
            Text(value)
                .font(.system(size: 22, weight: .black, design: .rounded))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.7)
            Text(title)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.white.opacity(0.42))
        }
        .frame(maxWidth: .infinity)
        .frame(height: 106)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.09)))
    }

    private func recapStat(icon: String, value: String, title: String) -> some View {
        VStack(spacing: 7) {
            Label(title, systemImage: icon)
                .font(.system(size: 10, weight: .black))
                .foregroundStyle(.white.opacity(0.64))
                .minimumScaleFactor(0.7)
            Text(value)
                .font(.system(size: 22, weight: .black, design: .rounded))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }

    private func summaryButtonLabel(title: String, icon: String, isPrimary: Bool) -> some View {
        Label(title, systemImage: icon)
            .font(.system(size: 17, weight: .black))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 64)
            .background {
                if isPrimary {
                    LinearGradient(colors: [Color.brandPurple, .pink], startPoint: .leading, endPoint: .trailing)
                } else {
                    Color.white.opacity(0.11)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(.white.opacity(isPrimary ? 0.20 : 0.09)))
    }

    private func compactNumber(_ value: Int) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", Double(value) / 1_000_000)
        }
        if value >= 1_000 {
            return String(format: "%.1fK", Double(value) / 1_000)
        }
        return value.formatted()
    }

    private func formatClipTime(_ seconds: Double) -> String {
        formatSavedDuration(max(0, Int(seconds.rounded())))
    }

    private func shareSelectedClip() {
        guard let videoURL else { return }
        isPreparingShare = true
        saveMessage = nil
        exportSelectedClip(from: videoURL) { result in
            isPreparingShare = false
            switch result {
            case .success(let url):
                shareItem = LiveClipShareItem(url: url)
            case .failure:
                saveMessage = "Unable to prepare selected clip"
            }
        }
    }

    private func saveToPhotos() {
        guard let videoURL else {
            saveMessage = "Recording unavailable"
            return
        }
#if os(iOS)
        isSaving = true
        saveMessage = nil
        exportSelectedClip(from: videoURL) { exportResult in
            switch exportResult {
            case .failure:
                isSaving = false
                saveMessage = "Unable to prepare selected clip"
            case .success(let selectedURL):
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                    guard status == .authorized || status == .limited else {
                        DispatchQueue.main.async {
                            isSaving = false
                            saveMessage = "Photo access is required"
                        }
                        return
                    }
                    PHPhotoLibrary.shared().performChanges {
                        PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: selectedURL)
                    } completionHandler: { success, _ in
                        DispatchQueue.main.async {
                            isSaving = false
                            saveMessage = success ? "Saved to Photos" : "Unable to save video"
                        }
                    }
                }
            }
        }
#else
        saveMessage = "Saving is available on iPhone"
#endif
    }

    private func exportSelectedClip(from sourceURL: URL, completion: @escaping (Result<URL, Error>) -> Void) {
#if os(iOS)
        let asset = AVURLAsset(url: sourceURL)
        Task { @MainActor in
            let loadedDuration = try? await asset.load(.duration)
            let measuredDuration = loadedDuration.map(CMTimeGetSeconds) ?? 0
            let duration = measuredDuration.isFinite && measuredDuration > 0
                ? measuredDuration
                : max(Double(video.durationSeconds), 1)
            let startSeconds = min(max(duration * clipStart, 0), duration)
            let endSeconds = min(max(duration * clipEnd, startSeconds + 0.1), duration)
            if startSeconds <= 0.05 && endSeconds >= duration - 0.05 {
                completion(.success(sourceURL))
                return
            }

            guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
                completion(.failure(LiveClipExportError.unavailable))
                return
            }
            let outputURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("squadlive-clip-\(UUID().uuidString).mov")
            try? FileManager.default.removeItem(at: outputURL)
            exporter.outputURL = outputURL
            exporter.outputFileType = .mov
            exporter.shouldOptimizeForNetworkUse = true
            exporter.timeRange = CMTimeRange(
                start: CMTime(seconds: startSeconds, preferredTimescale: 600),
                duration: CMTime(seconds: endSeconds - startSeconds, preferredTimescale: 600)
            )
            let exporterBox = LiveClipExporterBox(exporter)
            exporterBox.exporter.exportAsynchronously {
                DispatchQueue.main.async {
                    if exporterBox.exporter.status == .completed {
                        completion(.success(outputURL))
                    } else {
                        completion(.failure(exporterBox.exporter.error ?? LiveClipExportError.failed))
                    }
                }
            }
        }
#else
        completion(.success(sourceURL))
#endif
    }
}

private struct LiveClipShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

private enum LiveClipExportError: Error {
    case unavailable
    case failed
}

#if os(iOS)
private final class LiveClipExporterBox: @unchecked Sendable {
    let exporter: AVAssetExportSession

    init(_ exporter: AVAssetExportSession) {
        self.exporter = exporter
    }
}
#endif

#if os(iOS)
private struct LiveClipShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
#else
private struct LiveClipShareSheet: View {
    let url: URL
    var body: some View { EmptyView() }
}
#endif

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

    @Environment(\.openURL) private var openURL
    @State private var supportIdentity: StoreSupportIdentity?
    @State private var isLoadingSupportIdentity = false
    @State private var copiedMessage: String?
    @State private var showingPartnerReferral = false
#if os(iOS)
    @StateObject private var appleSignIn = AppleSignInCoordinator()
#endif

    private var displayedUserID: String {
        supportIdentity?.backendUserID ?? SquadLiveDeviceIdentity.value
    }

    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: "Settings", onBack: onBack)

            ScrollView {
                VStack(spacing: 14) {
                    InfoRow(icon: "person.2.fill", title: "AI-Only Audience", description: "SquadLive uses simulated AI friends and activity. No real human viewers join your room.")
                    InfoRow(icon: "shield.fill", title: "On-Device Data", description: "Your profile, preferences, saved AI reply history, and live recordings are stored on this device.")
                    InfoRow(icon: "network", title: "AI Processing", description: "Conversation text and limited on-device scene analysis are sent to the AI service to generate replies.")

                    Button {
                        showingPartnerReferral = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 18, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 42, height: 42)
                                .background(Color.brandPurple.opacity(0.72), in: Circle())
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Share App / Invite Code")
                                    .font(.system(size: 16, weight: .black))
                                    .foregroundStyle(.white)
                                Text("Share SquadLive or save a verified invitation code.")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.52))
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.white.opacity(0.38))
                        }
                        .padding(16)
                        .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Color.brandPurple.opacity(0.24)))
                    }
                    .buttonStyle(.plain)

#if os(iOS)
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Protect Your Account")
                            .font(.system(size: 16, weight: .black))
                            .foregroundStyle(.white)
                        Text("Link this wallet to your Apple account so it can be recovered on another device.")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.white.opacity(0.52))
                        if appleSignIn.isSigningIn {
                            ProgressView("Verifying with SquadLive...")
                                .font(.system(size: 11, weight: .semibold))
                                .tint(Color.brandPurple)
                        }
                        if let message = appleSignIn.message {
                            Text(message)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.orange)
                        }
                        Button {
                            appleSignIn.start { identityToken, displayName in
                                Task {
                                    if let user = await StoreBackendClient.linkAppleAccount(identityToken: identityToken, displayName: displayName) {
                                        await MainActor.run {
                                            supportIdentity = StoreSupportIdentity(
                                                backendUserID: user.id ?? SquadLiveDeviceIdentity.value,
                                                lookupID: user.deviceId ?? SquadLiveDeviceIdentity.value
                                            )
                                            appleSignIn.message = "Account protected. Your wallet is linked to Apple."
                                        }
                                    } else {
                                        await MainActor.run {
                                            appleSignIn.message = "Could not link your account. Please try again."
                                        }
                                    }
                                }
                            }
                        } label: {
                            Text(appleSignIn.isSigningIn ? "Connecting..." : "Link Apple Account")
                                .font(.system(size: 14, weight: .black))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .frame(height: 44)
                                .background(Color.brandPurple, in: RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                        .disabled(appleSignIn.isSigningIn)
                    }
                    .padding(16)
                    .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Color.brandPurple.opacity(0.24)))
#endif

                    VStack(alignment: .leading, spacing: 14) {
                        HStack(spacing: 12) {
                            Image(systemName: "questionmark.bubble.fill")
                                .font(.system(size: 18, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 42, height: 42)
                                .background(Color.brandPurple.opacity(0.72), in: Circle())
                            VStack(alignment: .leading, spacing: 3) {
                                Text("My User ID & Feedback")
                                    .font(.system(size: 16, weight: .black))
                                    .foregroundStyle(.white)
                                Text("Copy your ID for support or backend account lookup.")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.52))
                            }
                            Spacer()
                        }

                        VStack(alignment: .leading, spacing: 7) {
                            Text(supportIdentity == nil ? "USER LOOKUP ID" : "BACKEND USER ID")
                                .font(.system(size: 10, weight: .black))
                                .tracking(1.1)
                                .foregroundStyle(Color.brandPurple)
                            Text(displayedUserID)
                                .font(.system(size: 13, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.94))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.black.opacity(0.26), in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.10)))

                        if let supportIdentity {
                            HStack(spacing: 5) {
                                Text("Lookup ID:")
                                    .fontWeight(.bold)
                                Text(supportIdentity.lookupID)
                                    .font(.system(size: 10, design: .monospaced))
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .font(.system(size: 11))
                            .foregroundStyle(.white.opacity(0.42))
                        }

                        HStack(spacing: 10) {
                            Button(action: copySupportID) {
                                Label(copiedMessage == nil ? "Copy User ID" : "Copied", systemImage: copiedMessage == nil ? "doc.on.doc" : "checkmark.circle.fill")
                                    .font(.system(size: 13, weight: .black))
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 48)
                                    .background(Color.brandPurple, in: RoundedRectangle(cornerRadius: 14))
                            }
                            .buttonStyle(.plain)

                            Button(action: sendSupportEmail) {
                                Label("Email Support", systemImage: "envelope.fill")
                                    .font(.system(size: 13, weight: .black))
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 48)
                                    .background(.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
                                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.10)))
                            }
                            .buttonStyle(.plain)
                        }

                        if isLoadingSupportIdentity {
                            HStack(spacing: 8) {
                                ProgressView().tint(Color.brandPurple)
                                Text("Connecting your support ID...")
                            }
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.48))
                        } else if supportIdentity == nil {
                            Text("The lookup ID shown above can also be searched directly in the admin dashboard.")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.white.opacity(0.42))
                        }
                    }
                    .padding(16)
                    .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Color.brandPurple.opacity(0.24)))
                }
                .padding(.horizontal, 24)
                .padding(.top, 18)
                .padding(.bottom, 30)
            }
        }
        .sheet(isPresented: $showingPartnerReferral) {
            PartnerReferralCenterView()
        }
        .task {
            SquadLiveAnalytics.log("settings_viewed")
            guard supportIdentity == nil else { return }
            isLoadingSupportIdentity = true
            supportIdentity = await StoreBackendClient.fetchSupportIdentity()
            isLoadingSupportIdentity = false
        }
    }

    private func copySupportID() {
#if os(iOS)
        UIPasteboard.general.string = displayedUserID
#endif
        SquadLiveAnalytics.log("user_id_copied")
        copiedMessage = "Copied"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
            copiedMessage = nil
        }
    }

    private func sendSupportEmail() {
        SquadLiveAnalytics.log("feedback_started", parameters: ["source": "settings"])
        let backendUserID = supportIdentity?.backendUserID ?? "Pending server lookup"
        let lookupID = supportIdentity?.lookupID ?? SquadLiveDeviceIdentity.value
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
        let body = """
        Please describe your feedback or issue here:


        --- SquadLive Support Information ---
        Backend User ID: \(backendUserID)
        User Lookup ID: \(lookupID)
        App Version: \(appVersion) (\(build))
        Please keep the IDs above so support can locate your account.
        """
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = "1655896527@qq.com"
        components.queryItems = [
            URLQueryItem(name: "subject", value: "SquadLive Feedback [\(backendUserID)]"),
            URLQueryItem(name: "body", value: body)
        ]
        guard let url = components.url else { return }
        openURL(url)
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
                    SettingToggleRow(icon: "text.bubble.fill", title: "Ambient AI Comments", description: "Show short background audience reactions between direct AI replies.", isOn: $preferences.commentsEnabled)
                    SettingToggleRow(icon: "heart.fill", title: "Floating Hearts", description: "Show tap-to-send heart reactions.", isOn: $preferences.heartsEnabled)
                    SettingToggleRow(icon: "gift.fill", title: "Automatic Gifts", description: "Allow AI viewers to send animated gifts during live sessions.", isOn: $preferences.giftsEnabled)
                    SettingToggleRow(icon: "lock.fill", title: "PRO Reminder", description: "After four minutes, periodically explain how PRO restores high-frequency AI replies and gifts.", isOn: $preferences.autoPaywall)

                    VStack(alignment: .leading, spacing: 12) {
                        Text("AI Activity")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.white)
                        Text("Free sessions begin with four minutes of normal AI and gift activity. After that, activity gradually slows. PRO keeps dynamic 1–3 friend replies and gifts highly active.")
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

private enum LiveDisplayMode: Int {
    case full
    case chatOnly
    case cameraOnly

    var next: LiveDisplayMode {
        switch self {
        case .full: .chatOnly
        case .chatOnly: .cameraOnly
        case .cameraOnly: .full
        }
    }

    var previous: LiveDisplayMode {
        switch self {
        case .full: .cameraOnly
        case .chatOnly: .full
        case .cameraOnly: .chatOnly
        }
    }

    var title: String {
        switch self {
        case .full: "Full controls"
        case .chatOnly: "Chat only"
        case .cameraOnly: "Clean camera"
        }
    }
}

private struct LiveStreamView: View {
    let listener: Listener
    let listeners: [Listener]
    let userName: String
    let userAvatarData: Data?
    @Binding var preferences: AppPreferences
    let initialPopularity: Int
    let purchasedAudienceCount: Int
    let audienceArrivalMinutes: Double
    @Binding var showPaywall: Bool
    let onEnd: (LiveSessionSummary) -> Void
    let onStartFailureExit: () -> Void
    let onShowCoinStore: () -> Void
    let onUpgrade: () -> Void
    let onCoinsChanged: (Int) -> Void
    let onRequestReview: () -> Void

    @StateObject private var speechTranscriber = SpeechTranscriber()
    @StateObject private var cameraRecorder = LiveCameraRecorder()
    @State private var popularity: Int
    @State private var coins: Int
    @State private var isRecording = true
    @State private var displayMode: LiveDisplayMode = .full
    @State private var displayModeHint: String?
    @State private var displayModeHintToken = UUID()
    @State private var showExitConfirm = false
    @State private var comments: [ChatComment] = []
    @State private var commentExpiryTokens: [UUID: UUID] = [:]
    @State private var latestDisplayedDeepAnswerID: UUID?
    @State private var chatHistory: [ChatComment] = []
    @State private var showChatHistory = false
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
    @State private var speechReplyTimer: Timer?
    @State private var lastProcessedTranscript = ""
    @State private var pendingDeepPrompts: [String] = []
    @State private var recentSpeechPromptTimes: [String: TimeInterval] = [:]
    @State private var conversationMemories: [String: [DeepSeekMessage]] = [:]
    @State private var nextResponderIndex = 0
    @State private var lastDeepAnswerTime = -120
    @State private var deepAnswerVisibleUntil = -1
    @State private var deepAnswerInFlight = false
    @State private var activeDeepRequestID: UUID?
    @State private var hasRequestedOpeningGreeting = false
    @State private var lastBarrageCommentText = ""
    @State private var lastVibeCommentName = ""
    @State private var usedVibeCommentTexts: Set<String> = []
    @State private var openingCommentIndex = 0
    @State private var openingAudienceWaves = 0
    @State private var lastRobotActivityTime = 0
    @State private var liveEngagementSessionID = UUID()
    @State private var hasStartedLiveRuntime = false
    @State private var hasReportedUserInteraction = false
    @State private var hasReportedAIReply = false
    @State private var lastVisualAIContext = ""
    @State private var lastVisualAIReactionTime = -120
    @State private var silentUserNudgeCount = 0
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
    @State private var selectedGiftIndexes: [Int] = []
    @State private var liveToolMessage: String?
    @State private var isBuyingLiveViewers = false
    @State private var pendingLiveAudienceOperationID: UUID?
    @State private var pendingLiveAudienceViewers: Int?
    @State private var audienceBoostUntil = 0
    @State private var audienceTargetPopularity: Int?
    @State private var hasManualAudienceAdditions = false
    @State private var paywallCooldownUntil = 0
    @State private var isFinishingLive = false
    @State private var showLiveReviewPrompt = false
    @State private var hasShownThreeMinuteReviewPrompt = false
    @State private var pendingLiveSummary: LiveSessionSummary?
    @State private var totalLikes = 0
    @State private var totalComments = 0
    @State private var totalGifts = 0
    @State private var thermalState = ProcessInfo.processInfo.thermalState

    private let aiComments = [
        ("Emma", "👩", "That confidence looks good on you."),
        ("Jake", "👨", "Your energy is really clear today."),
        ("Lily", "👧", "I love how honest you are being."),
        ("Marcus", "🧔", "That was a strong point."),
        ("Sofia", "👱‍♀️", "You explain things in such a real way."),
        ("Ryan", "👨‍🦰", "The room is locked in with you."),
        ("Zoe", "👩‍🦱", "That felt personal and powerful."),
        ("Alex", "🧑", "Keep going, this is resonating."),
        ("Jane", "✨", "This live is taking off."),
        ("Luna", "🌙", "You are literally glowing right now."),
        ("Yoash", "🔥", "How do you make this look so effortless?"),
        ("Sam", "⚡️", "What a vibe!"),
        ("Ken", "🙌", "Your energy has the whole room here."),
        ("Mia", "💫", "This is such a clip-worthy moment."),
        ("Ava", "🫶", "Your smile just lifted the whole room."),
        ("Noah", "👑", "Okay, main-character energy."),
        ("Chloe", "🐰", "You look so comfortable on camera."),
        ("Harper", "🌟", "Your voice is so easy to listen to."),
        ("Nora", "💬", "This deserves way more viewers."),
        ("Ivy", "⚡️", "The confidence today is everything."),
        ("Sophia", "💖", "The room found the right live."),
        ("Emma", "👩", "The camera really loves you today."),
        ("Jake", "👨", "You make this feel completely effortless."),
        ("Lily", "👧", "I could honestly listen to this all day."),
        ("Marcus", "🧔", "That point landed harder than expected."),
        ("Sofia", "👱‍♀️", "Your storytelling is so easy to follow."),
        ("Ryan", "👨‍🦰", "The energy just went up."),
        ("Zoe", "👩‍🦱", "You are owning this moment."),
        ("Alex", "🧑", "This deserves to be on everyone's feed."),
        ("Jane", "✨", "I joined at exactly the right time."),
        ("Luna", "🌙", "Your calm energy is contagious."),
        ("Yoash", "🔥", "You have natural creator energy."),
        ("Sam", "⚡️", "The whole vibe is immaculate."),
        ("Ken", "🙌", "You have everyone's attention right now."),
        ("Mia", "💫", "That smile just changed the whole vibe."),
        ("Ava", "🫶", "This feels like talking to a close friend."),
        ("Noah", "👑", "You are making this look way too easy."),
        ("Chloe", "🐰", "This lighting was made for you."),
        ("Harper", "🌟", "Your voice has such a soothing tone."),
        ("Nora", "💬", "This is the kind of live I needed today."),
        ("Ivy", "⚡️", "Your confidence is showing in the best way."),
        ("Sophia", "💖", "Your presence feels so warm."),
        ("Emma", "👩", "The way you tell stories is everything."),
        ("Jake", "👨", "Not me staying for the whole story."),
        ("Lily", "👧", "You are glowing without even trying."),
        ("Marcus", "🧔", "That was honestly inspiring."),
        ("Sofia", "👱‍♀️", "Your honesty is really refreshing."),
        ("Ryan", "👨‍🦰", "This room keeps getting better."),
        ("Zoe", "👩‍🦱", "You look amazing from this angle."),
        ("Alex", "🧑", "You make people want to stay and listen."),
        ("Jane", "✨", "This is low-key my favorite live today."),
        ("Luna", "🌙", "Wait, why is this so calming?"),
        ("Yoash", "🔥", "Your voice has real podcast energy."),
        ("Sam", "⚡️", "That timing was actually perfect."),
        ("Ken", "🙌", "The room is fully locked in."),
        ("Mia", "💫", "This moment deserves a replay."),
        ("Ava", "🫶", "I really needed to hear that today."),
        ("Noah", "👑", "The confidence shift is real."),
        ("Chloe", "🐰", "You look so natural doing this."),
        ("Harper", "🌟", "Your voice makes the room feel peaceful."),
        ("Nora", "💬", "How does this not have more likes?"),
        ("Ivy", "⚡️", "The energy here is actually addictive."),
        ("Sophia", "💖", "This room feels so positive."),
        ("Emma", "👩", "Your expression says everything."),
        ("Jake", "👨", "That was such a real moment."),
        ("Lily", "👧", "You are absolutely shining right now."),
        ("Marcus", "🧔", "Strong message, even stronger delivery."),
        ("Sofia", "👱‍♀️", "You make confidence look natural."),
        ("Ryan", "👨‍🦰", "This live has serious momentum."),
        ("Zoe", "👩‍🦱", "The styling and energy are both perfect."),
        ("Alex", "🧑", "People are going to remember this one.")
    ]
    private let openingComments = [
        ("Emma", "👩", "Hi, we are here with you 👋"),
        ("Jake", "👨", "You already look comfortable on camera ✨"),
        ("Lily", "👧", "Your vibe is warm today 💜"),
        ("Jane", "✨", "This already feels like a good live 🔥"),
        ("Sam", "⚡️", "What a vibe! 🙌"),
        ("Luna", "🌙", "You are glowing today 🥰")
    ]
    private let viewerJoinComments = [
        ("Mia", "👋", "came in to watch 👋"),
        ("Noah", "🔥", "joined from the live feed 🔥"),
        ("Ava", "💫", "is watching now ✨"),
        ("Chloe", "🫶", "just entered the room 💜"),
        ("Harper", "✨", "is watching now 👀"),
        ("Nora", "💬", "came in to listen 🎧"),
        ("Ivy", "⚡️", "joined the live ⚡️"),
        ("Sophia", "👑", "just arrived 🙌"),
        ("Leo", "🌟", "found your live and stayed 🌟"),
        ("Olivia", "💖", "just joined the room 💖"),
        ("Ethan", "🚀", "came in from For You 🚀"),
        ("Zoe", "🥰", "is watching with everyone 🥰")
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
        "Jane": "https://randomuser.me/api/portraits/women/41.jpg",
        "Luna": "https://randomuser.me/api/portraits/women/21.jpg",
        "Sam": "https://randomuser.me/api/portraits/women/57.jpg",
        "Jake": "https://randomuser.me/api/portraits/men/32.jpg",
        "Marcus": "https://randomuser.me/api/portraits/men/46.jpg",
        "Ryan": "https://randomuser.me/api/portraits/men/22.jpg",
        "Alex": "https://randomuser.me/api/portraits/men/65.jpg",
        "Noah": "https://randomuser.me/api/portraits/men/11.jpg",
        "Yoash": "https://randomuser.me/api/portraits/men/54.jpg",
        "Ken": "https://randomuser.me/api/portraits/men/38.jpg"
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

    init(listener: Listener, listeners: [Listener], userName: String, userAvatarData: Data?, preferences: Binding<AppPreferences>, initialPopularity: Int, purchasedAudienceCount: Int, audienceArrivalMinutes: Double, showPaywall: Binding<Bool>, onEnd: @escaping (LiveSessionSummary) -> Void, onStartFailureExit: @escaping () -> Void, onShowCoinStore: @escaping () -> Void, onUpgrade: @escaping () -> Void, onCoinsChanged: @escaping (Int) -> Void, onRequestReview: @escaping () -> Void) {
        let currentPreferences = preferences.wrappedValue
        self.listener = listener
        self.listeners = listeners
        self.userName = userName
        self.userAvatarData = userAvatarData
        self._preferences = preferences
        self.initialPopularity = initialPopularity
        self.purchasedAudienceCount = purchasedAudienceCount
        self.audienceArrivalMinutes = audienceArrivalMinutes
        self._showPaywall = showPaywall
        self.onEnd = onEnd
        self.onStartFailureExit = onStartFailureExit
        self.onShowCoinStore = onShowCoinStore
        self.onUpgrade = onUpgrade
        self.onCoinsChanged = onCoinsChanged
        self.onRequestReview = onRequestReview
        self._popularity = State(initialValue: max(100, initialPopularity))
        self._coins = State(initialValue: currentPreferences.coins)
        self._hasManualAudienceAdditions = State(initialValue: purchasedAudienceCount > 0)
        self._liveToneTopics = State(initialValue: currentPreferences.activeCommentCategories.map { $0.capitalized })
        let mappedVibes = currentPreferences.selectedVibes.map { vibe in
            switch vibe {
            case "Hater": return "Haters"
            case "Flirtatious": return "Flirty"
            case "Joker", "Sarcastic": return "Funny"
            case "Questioner", "Intellectual", "Critic": return "Curious"
            case "Fan", "Supporter", "Motivator": return "Hype"
            case "Emotional": return "Happy"
            default: return vibe
            }
        }
        self._liveVibeMoods = State(initialValue: mappedVibes.isEmpty ? ["Hype", "Happy"] : Array(Set(mappedVibes)))
    }

    private var activeAIListeners: [Listener] {
        var active = [listener]
        for candidate in listeners where !active.contains(where: { $0.id == candidate.id }) {
            active.append(candidate)
        }
        return Array(active.prefix(3))
    }

    private var hasConversationMemory: Bool {
        conversationMemories.values.contains { !$0.isEmpty }
    }

    private var isAIActivityReduced: Bool {
        shouldApplyLowCoinAudienceDecay && streamTime >= lowCoinAudienceDecayStart
    }

    private var minimumAIReplyInterval: Int {
        guard isAIActivityReduced else { return 0 }
        switch streamTime {
        case 600..<660: return 14
        case 660..<720: return 24
        case 720..<840: return 36
        default: return 44
        }
    }

    private var voiceReplyCooldown: Int {
        shouldApplyLowCoinAudienceDecay ? 3 : 0
    }

    private func orderedResponders() -> [Listener] {
        let active = activeAIListeners
        guard active.count > 1 else { return active }
        let startIndex = nextResponderIndex % active.count
        return Array(active[startIndex...] + active[..<startIndex])
    }

    private func responderCount(for prompt: String, remembersPrompt: Bool) -> Int {
        let availableCount = activeAIListeners.count
        guard availableCount > 1 else { return availableCount }
        if !remembersPrompt { return 1 }

        let lowercased = prompt.lowercased()
        let asksForGroup = ["你们", "大家", "三个人", "一起", "陪陪我", "all of you", "everyone", "you guys", "both of you", "stay with me"]
            .contains { lowercased.contains($0) }
        let needsSupport = ["难过", "伤心", "孤独", "害怕", "焦虑", "压力", "崩溃", "失眠", "不开心", "陪我", "sad", "lonely", "afraid", "anxious", "stressed", "overwhelmed", "depressed", "upset"]
            .contains { lowercased.contains($0) }
        let celebrates = ["开心", "高兴", "激动", "成功", "做到了", "生日", "庆祝", "happy", "excited", "proud", "celebrate", "birthday", "i did it"]
            .contains { lowercased.contains($0) }
        let asksAdvice = prompt.contains("?") || prompt.contains("？") || ["怎么办", "怎么选", "建议", "应该", "why", "how", "what should", "advice", "choose"]
            .contains { lowercased.contains($0) }

        if isAIActivityReduced {
            if streamTime < 300 && (asksForGroup || needsSupport) && Int.random(in: 0..<100) < 35 {
                return min(2, availableCount)
            }
            return 1
        }

        let roll = Int.random(in: 0..<100)
        if asksForGroup || needsSupport {
            return min(roll < 68 ? 3 : 2, availableCount)
        }
        if celebrates {
            return min(roll < 42 ? 3 : (roll < 82 ? 2 : 1), availableCount)
        }
        if asksAdvice || prompt.count > 70 {
            return min(roll < 18 ? 3 : (roll < 68 ? 2 : 1), availableCount)
        }
        return min(roll < 62 ? 1 : (roll < 92 ? 2 : 3), availableCount)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            CameraPreview(recorder: cameraRecorder, beautyIntensity: beautyFilter)
                .ignoresSafeArea()
                .overlay {
                    if displayMode != .cameraOnly {
                        liveFilterEffect
                    }
                }
            if !showExitConfirm, case .starting = cameraRecorder.captureState {
                cameraStartupOverlay(
                    title: "Starting camera...",
                    message: "Preparing your live session. This should only take a moment.",
                    showsRetry: false
                )
            } else if !showExitConfirm, case .failed(let message) = cameraRecorder.captureState {
                cameraStartupOverlay(
                    title: "Camera Couldn’t Start",
                    message: message,
                    showsRetry: true
                )
            }
            if displayMode != .cameraOnly {
                LinearGradient(colors: [.brandPurple.opacity(0.08), .black.opacity(0.04), .black.opacity(0.36)], startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea()
                    .opacity(showLiveToolPanel ? 0.08 : (displayMode == .chatOnly ? 0.72 : 1))
            }

            VStack(spacing: 0) {
                if displayMode == .full {
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
                }

                ZStack {
                    if displayMode == .full && !isRecording {
                        VStack(spacing: 14) {
                            UserAvatarView(imageData: userAvatarData, size: 124)
                            Text("\(userName)'s stream is paused")
                                .font(.system(size: 18, weight: .medium))
                                .foregroundStyle(.white.opacity(0.82))
                        }
                    }

                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                VStack(spacing: 12) {
                    if displayMode == .full, isRecording, let aiStatus = liveAIStatusText {
                        HStack(spacing: 8) {
                            if deepAnswerInFlight {
                                ProgressView()
                                    .tint(.white.opacity(0.86))
                                    .scaleEffect(0.72)
                            } else {
                                Circle()
                                    .fill(isSpeechRecognitionUnavailable ? Color.red : Color.green)
                                    .frame(width: 7, height: 7)
                            }
                            Text(aiStatus)
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(.white.opacity(0.84))
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 34)
                        .background(.black.opacity(0.48), in: Capsule())
                        .overlay(Capsule().stroke(.white.opacity(0.12)))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    if displayMode != .cameraOnly && preferences.commentsEnabled && isRecording {
                        VStack(spacing: 8) {
                            if displayMode == .full && !chatHistory.isEmpty {
                                HStack {
                                    Spacer()
                                    Button {
                                        withAnimation(.spring(response: 0.34, dampingFraction: 0.88)) {
                                            showChatHistory = true
                                        }
                                    } label: {
                                        Label("History", systemImage: "arrow.up")
                                            .font(.system(size: 11, weight: .bold))
                                            .foregroundStyle(.white.opacity(0.78))
                                            .padding(.horizontal, 10)
                                            .frame(height: 28)
                                            .background(.black.opacity(0.42), in: Capsule())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }

                            ForEach(Array(visibleLiveComments.enumerated()), id: \.element.id) { index, comment in
                                LiveCommentRow(
                                    comment: comment,
                                    imageURL: commentImageURL(for: comment),
                                    frameAsset: avatarFrame(for: comment.name),
                                    isPremium: isPremiumComment(comment)
                                )
                                .opacity(min(1.0, 0.82 + Double(index) * 0.035))
                                .fixedSize(horizontal: false, vertical: true)
                                .transition(.asymmetric(
                                    insertion: .move(edge: .leading).combined(with: .opacity).combined(with: .scale(scale: 0.96)),
                                    removal: .move(edge: .top).combined(with: .opacity)
                                ))
                            }
                        }
                        .frame(maxHeight: 340, alignment: .bottom)
                        .mask(
                            LinearGradient(
                                stops: [
                                    .init(color: .clear, location: 0),
                                    .init(color: .black.opacity(0.28), location: 0.08),
                                    .init(color: .black, location: 0.22)
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                        .contentShape(Rectangle())
                        .highPriorityGesture(
                            DragGesture(minimumDistance: 24)
                                .onEnded { value in
                                    if value.translation.height < -24, !chatHistory.isEmpty {
                                        withAnimation(.spring(response: 0.34, dampingFraction: 0.88)) {
                                            showChatHistory = true
                                        }
                                    }
                                }
                        )
                    }
                }
                .padding(.horizontal, 18)
                .padding(.bottom, displayMode == .chatOnly ? 28 : 10)

                if displayMode == .full {
                    HStack {
                    Button {
                        withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                            showLiveToolPanel.toggle()
                        }
                    } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(showLiveToolPanel ? .white : .white.opacity(0.72))
                            .frame(width: 48, height: 48)
                            .background(showLiveToolPanel ? Color.brandPurple.opacity(0.36) : .white.opacity(0.10), in: Circle())
                            .overlay(Circle().stroke(showLiveToolPanel ? Color.brandPurple.opacity(0.72) : .clear, lineWidth: 1.4))
                            .frame(width: 64, height: 64)
                    }
                    .buttonStyle(.plain)
                    .contentShape(Rectangle())

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
                            .frame(width: 48, height: 48)
                            .background(Color.red.opacity(0.15), in: Circle())
                            .overlay(Circle().stroke(Color.red.opacity(0.28)))
                            .frame(width: 64, height: 64)
                    }
                    .buttonStyle(.plain)
                    .contentShape(Rectangle())
                    }
                    .padding(.horizontal, 38)
                    .padding(.bottom, 16)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .opacity(showLiveToolPanel ? 0 : 1)
            .allowsHitTesting(displayMode != .cameraOnly && !showLiveToolPanel && !showChatHistory)

            if displayMode == .full && showLiveToolPanel {
                Color.black.opacity(0.08)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {
                        withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                            showLiveToolPanel = false
                        }
                    }

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
                    autoFakeDonations: $preferences.giftsEnabled,
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
                .frame(maxWidth: 372)
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
                .transition(.move(edge: .bottom).combined(with: .opacity).combined(with: .scale(scale: 0.97, anchor: .bottom)))
            }

            if displayMode == .full && !showLiveToolPanel {
                ForEach(activeGifts) { gift in
                    GiftEffectView(gift: gift)
                        .transition(.scale.combined(with: .opacity))
                }
            }

            if displayMode == .full && preferences.heartsEnabled && isRecording && !showLiveToolPanel {
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

            if displayMode == .full && showChatHistory && !showLiveToolPanel {
                Color.black.opacity(0.46)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(.easeOut(duration: 0.22)) {
                            showChatHistory = false
                        }
                    }

                LiveChatHistoryPanel(
                    comments: filteredChatHistory,
                    listener: listener,
                    avatarURLs: chatAvatarURLMap,
                    onClose: {
                        withAnimation(.easeOut(duration: 0.22)) {
                            showChatHistory = false
                        }
                    }
                )
                .padding(.horizontal, 16)
                .padding(.top, 118)
                .padding(.bottom, 104)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if displayMode == .full && showPaywall && !showLiveToolPanel && !showChatHistory {
                PaywallBanner(
                    listener: listener,
                    onClose: {
                        paywallCooldownUntil = streamTime + 90
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

            if displayMode == .full && showLiveReviewPrompt && !showLiveToolPanel && !showChatHistory {
                LiveReviewPrompt(
                    onPositiveFeedback: {
                        SquadLiveAnalytics.log("review_prompt_response", parameters: ["response": "positive", "source": "live"])
                        onRequestReview()
                        completeLiveReviewPrompt(after: 0.7)
                    },
                    onNegativeFeedback: {
                        SquadLiveAnalytics.log("review_prompt_response", parameters: ["response": "negative", "source": "live"])
                        completeLiveReviewPrompt()
                    }
                )
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
                .zIndex(8)
            }

            if displayMode == .full && showExitConfirm {
                ExitStreamConfirmView(
                    onCancel: { showExitConfirm = false },
                    onEnd: finishLiveSession
                )
                .transition(.opacity)
            }

            if let displayModeHint {
                Text(displayModeHint)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(height: 34)
                    .background(.black.opacity(0.54), in: Capsule())
                    .overlay(Capsule().stroke(.white.opacity(0.16)))
                    .padding(.bottom, 34)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    .allowsHitTesting(false)
            }
        }
        .contentShape(Rectangle())
        .simultaneousGesture(
            DragGesture(minimumDistance: 36)
                .onEnded { value in
                    handleDisplayModeSwipe(value.translation)
                }
        )
        .onAppear {
#if os(iOS)
            UIApplication.shared.isIdleTimerDisabled = true
#endif
            let transcriber = speechTranscriber
            cameraRecorder.setSpeechAudioHandler { [weak transcriber] sampleBuffer in
                transcriber?.appendAudioSampleBuffer(sampleBuffer)
            }
            cameraRecorder.updateBeautyIntensity(beautyFilter)
            applyThermalState(ProcessInfo.processInfo.thermalState)
            cameraRecorder.startCaptureAndRecording()
            Task { await DeepSeekClient.warmBackend() }
        }
        .onChange(of: cameraRecorder.captureState) { _, newValue in
            handleCameraCaptureState(newValue)
        }
        .onChange(of: beautyFilter) { _, newValue in
            cameraRecorder.updateBeautyIntensity(newValue)
        }
        .onChange(of: preferences.coins) { _, newValue in
            coins = newValue
        }
        .onChange(of: preferences.giftsEnabled) { _, isEnabled in
            handleGiftSettingChanged(isEnabled)
        }
        .onChange(of: isRecording) { _, newValue in
            handleRecordingChanged(newValue)
        }
        .onChange(of: speechTranscriber.transcript) { _, _ in
            scheduleSpeechReply()
        }
        .onChange(of: cameraRecorder.sceneContext) { _, newContext in
            handleVisualContextChange(newContext)
        }
        .onReceive(NotificationCenter.default.publisher(for: ProcessInfo.thermalStateDidChangeNotification)) { _ in
            applyThermalState(ProcessInfo.processInfo.thermalState)
        }
        .onDisappear {
#if os(iOS)
            UIApplication.shared.isIdleTimerDisabled = false
#endif
            stopTimers()
            cameraRecorder.setSpeechAudioHandler(nil)
            speechTranscriber.stop()
            if !isFinishingLive {
                cameraRecorder.cancelRecording()
                if hasStartedLiveRuntime {
                    Task {
                        await LiveEngagementClient.report(
                            type: "live_ended",
                            sessionId: liveEngagementSessionID,
                            durationSeconds: streamTime
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func cameraStartupOverlay(title: String, message: String, showsRetry: Bool) -> some View {
        ZStack {
            Color.black.opacity(0.78).ignoresSafeArea()
            VStack(spacing: 18) {
                if showsRetry {
                    Image(systemName: "video.slash.fill")
                        .font(.system(size: 38, weight: .bold))
                        .foregroundStyle(Color.red.opacity(0.9))
                } else {
                    ProgressView()
                        .tint(.white)
                        .scaleEffect(1.25)
                }
                Text(title)
                    .font(.system(size: 22, weight: .black))
                    .foregroundStyle(.white)
                Text(message)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white.opacity(0.68))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
                if showsRetry {
                    Button("Retry Camera") {
                        cameraRecorder.startCaptureAndRecording()
                    }
                    .font(.system(size: 16, weight: .black))
                    .foregroundStyle(.white)
                    .frame(width: 220, height: 50)
                    .background(Color.brandPurple, in: RoundedRectangle(cornerRadius: 15))
#if os(iOS)
                    Button("Open Settings") {
                        guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else { return }
                        UIApplication.shared.open(settingsURL)
                    }
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white.opacity(0.8))
#endif
                    Button("End Session") {
                        cameraRecorder.cancelRecording()
                        onStartFailureExit()
                    }
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Color.red.opacity(0.85))
                }
            }
        }
        .zIndex(20)
    }

    private func handleCameraCaptureState(_ state: LiveCameraCaptureState) {
        switch state {
        case .running:
            guard !hasStartedLiveRuntime else { return }
            hasStartedLiveRuntime = true
            preferences.pendingLobbyAudienceOperationID = nil
            preferences.pendingLobbyAudienceViewers = nil
            PersistenceStore.savePreferences(preferences)
            startTimers()
            speechTranscriber.start()
            SquadLiveAnalytics.log("live_camera_started")
            Task { await LiveEngagementClient.report(type: "live_started", sessionId: liveEngagementSessionID) }
        case .failed(let reason):
            stopTimers()
            speechTranscriber.stop()
            SquadLiveAnalytics.log("live_camera_start_failed", parameters: ["reason": reason])
            Task {
                await LiveEngagementClient.report(
                    type: "live_start_failed",
                    sessionId: liveEngagementSessionID,
                    reason: reason
                )
            }
        case .idle, .starting:
            break
        }
    }

    private func handleDisplayModeSwipe(_ translation: CGSize) {
        guard !showLiveToolPanel,
              !showChatHistory,
              !showExitConfirm,
              !showLiveReviewPrompt else { return }
        let horizontalDistance = translation.width
        let verticalDistance = translation.height
        guard abs(horizontalDistance) >= 64,
              abs(horizontalDistance) > abs(verticalDistance) * 1.35 else { return }

        let newMode = horizontalDistance > 0 ? displayMode.next : displayMode.previous
        let hintToken = UUID()
        displayModeHintToken = hintToken
        withAnimation(.easeInOut(duration: 0.24)) {
            displayMode = newMode
            displayModeHint = newMode.title
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.15) {
            guard displayModeHintToken == hintToken else { return }
            withAnimation(.easeOut(duration: 0.22)) {
                displayModeHint = nil
            }
        }
    }

    private func finishLiveSession() {
        guard !isFinishingLive else { return }
        isFinishingLive = true
        showExitConfirm = false
        stopTimers()
        speechTranscriber.stop()
        Task {
            await LiveEngagementClient.report(
                type: "live_ended",
                sessionId: liveEngagementSessionID,
                durationSeconds: streamTime
            )
        }
        cameraRecorder.stopRecording { recordingURL in
            let summary = LiveSessionSummary(
                duration: streamTime,
                peakViewers: max(popularity, initialPopularity),
                likes: totalLikes,
                comments: totalComments,
                gifts: totalGifts,
                recordingURL: recordingURL
            )
            pendingLiveSummary = summary
            SquadLiveAnalytics.log("review_prompt_shown", parameters: ["source": "live_end"])
            withAnimation(.spring(response: 0.34, dampingFraction: 0.88)) {
                showLiveReviewPrompt = true
            }
        }
    }

    private func advanceToLiveSummary(after delay: TimeInterval = 0) {
        guard let summary = pendingLiveSummary else { return }
        pendingLiveSummary = nil
        showLiveReviewPrompt = false
        let showSummary = {
            onEnd(summary)
        }
        if delay > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: showSummary)
        } else {
            showSummary()
        }
    }

    private func completeLiveReviewPrompt(after delay: TimeInterval = 0) {
        guard pendingLiveSummary != nil else {
            let dismiss = {
                withAnimation(.easeOut(duration: 0.22)) {
                    showLiveReviewPrompt = false
                }
            }
            if delay > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: dismiss)
            } else {
                dismiss()
            }
            return
        }
        advanceToLiveSummary(after: delay)
    }

    private func startTimers() {
        stopTimers()
        popularity = max(100, initialPopularity)
        audienceTargetPopularity = nil
        audienceBoostUntil = 0
        hasManualAudienceAdditions = purchasedAudienceCount > 0
        showBanner = true
        comments = []
        commentExpiryTokens = [:]
        latestDisplayedDeepAnswerID = nil
        chatHistory = LiveChatHistoryStore.load()
        showChatHistory = false
        streamTime = 0
        totalLikes = 0
        totalComments = 0
        totalGifts = 0
        activeGifts = []
        lastProcessedTranscript = ""
        pendingDeepPrompts = []
        recentSpeechPromptTimes = [:]
        conversationMemories = [:]
        nextResponderIndex = 0
        lastDeepAnswerTime = -120
        deepAnswerVisibleUntil = -1
        deepAnswerInFlight = false
        activeDeepRequestID = nil
        hasRequestedOpeningGreeting = false
        hasReportedUserInteraction = false
        hasReportedAIReply = false
        lastVisualAIContext = ""
        lastVisualAIReactionTime = -120
        silentUserNudgeCount = 0
        showLiveReviewPrompt = false
        hasShownThreeMinuteReviewPrompt = false
        pendingLiveSummary = nil
        openingCommentIndex = 0
        lastBarrageCommentText = ""
        lastVibeCommentName = ""
        usedVibeCommentTexts = []
        openingAudienceWaves = 0
        lastRobotActivityTime = 0
        preloadLiveAvatars()

        if preferences.commentsEnabled {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                guard isRecording, visibleLiveComments.isEmpty else { return }
                appendViewerJoinComment()
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
            requestOpeningAIGreetingIfNeeded()
        }

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
            if preferences.commentsEnabled
                && (!isDeepAnswerVisible || preferences.isPremiumMember)
                && (delta > 90 || isAudienceBoostActive)
                && Int.random(in: 0...100) < (preferences.isPremiumMember ? 58 : (isAudienceBoostActive ? 62 : 32)) {
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
            ensureAudienceContinuity()
            maybeRequestDeepAnswer()
            if streamTime == 14 {
                requestSilentUserNudgeIfNeeded()
            }
            if streamTime == 42 {
                requestSilentUserNudgeIfNeeded()
            }
            if streamTime >= 180,
               !hasShownThreeMinuteReviewPrompt,
               !isFinishingLive,
               !showExitConfirm,
               !showLiveToolPanel,
               !showChatHistory,
               !showLiveReviewPrompt {
                hasShownThreeMinuteReviewPrompt = true
                showPaywall = false
                SquadLiveAnalytics.log("review_prompt_shown", parameters: ["source": "live_three_minutes"])
                withAnimation(.spring(response: 0.34, dampingFraction: 0.88)) {
                    showLiveReviewPrompt = true
                }
            }
            if preferences.autoPaywall && !preferences.isPremiumMember && streamTime >= 240 && streamTime >= paywallCooldownUntil && !showPaywall && !showLiveToolPanel && !showChatHistory && !showLiveReviewPrompt {
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

    private func handleGiftSettingChanged(_ isEnabled: Bool) {
        giftTimer?.invalidate()
        giftTimer = nil
        guard isEnabled else {
            withAnimation(.easeOut(duration: 0.2)) {
                activeGifts.removeAll()
            }
            return
        }
        if isRecording {
            scheduleNextAIGift(initialDelay: true)
        }
    }

    private var isThermallyLimited: Bool {
        thermalState == .serious || thermalState == .critical
    }

    private var isThermallyCritical: Bool {
        thermalState == .critical
    }

    private func applyThermalState(_ newState: ProcessInfo.ThermalState) {
        guard thermalState != newState || newState != .nominal else {
            cameraRecorder.updateThermalState(newState)
            return
        }
        thermalState = newState
        cameraRecorder.updateThermalState(newState)

        if newState == .serious || newState == .critical {
            activeGifts.removeAll()
            if newState == .critical {
                hearts.removeAll()
            }
            if isRecording {
                scheduleNextAIGift()
                scheduleNextAutoHeart()
            }
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
        Button {
            if !preferences.isPremiumMember {
                onUpgrade()
            }
        } label: {
            HStack(spacing: 5) {
                if preferences.isPremiumMember {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 11, weight: .bold))
                }
                Text(preferences.isPremiumMember ? "PRO ACTIVE" : "PRO")
            }
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
        speechReplyTimer?.invalidate()
        speechReplyTimer = nil
    }

    private func preloadLiveAvatars() {
#if os(iOS)
        var urls = Array(commentAvatarURLMap.values)
        urls.append(contentsOf: activeAIListeners.map(\.imageURL))
        urls.append(contentsOf: AICompanionCatalog.friends.map(\.imageURL))
        RemoteImageCache.prefetch(urlStrings: urls)
#endif
    }

    private func scheduleOpeningAudienceWarmup() {
        warmupTimer?.invalidate()
        guard isRecording else { return }

        let interval: Double
        if preferences.isPremiumMember {
            switch streamTime {
            case 0..<15:
                interval = Double.random(in: 0.24...0.46)
            case 15..<45:
                interval = Double.random(in: 0.34...0.66)
            case 45..<90:
                interval = Double.random(in: 0.52...0.92)
            case 90..<180:
                interval = Double.random(in: 0.72...1.18)
            default:
                interval = Double.random(in: 0.90...1.65)
            }
        } else if isAudienceBoostActive {
            interval = streamTime < 180 ? Double.random(in: 0.32...0.78) : Double.random(in: 1.1...2.2)
        } else if popularity >= 10_000 {
            switch streamTime {
            case 0..<15:
                interval = Double.random(in: 0.24...0.48)
            case 15..<45:
                interval = Double.random(in: 0.38...0.72)
            case 45..<90:
                interval = Double.random(in: 0.62...1.05)
            case 90..<180:
                interval = Double.random(in: 0.90...1.50)
            default:
                interval = Double.random(in: 3.5...6.0)
            }
        } else {
            switch streamTime {
            case 0..<12:
                interval = Double.random(in: 0.28...0.52)
            case 12..<45:
                interval = Double.random(in: 0.42...0.72)
            case 45..<90:
                interval = Double.random(in: 0.48...0.88)
            case 90..<180:
                interval = Double.random(in: 0.78...1.32)
            case 180..<480:
                interval = Double.random(in: 1.7...3.0)
            case 480..<720:
                interval = Double.random(in: 2.0...3.4)
            default:
                interval = Double.random(in: 2.4...4.2)
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
        let requestedDuration = Int(audienceArrivalMinutes * 60)
        audienceBoostUntil = streamTime + max(60, min(3_600, requestedDuration))
    }

    private func applyOpeningAudienceWave() {
        openingAudienceWaves += 1

        let joinCount: Int
        if preferences.isPremiumMember {
            switch streamTime {
            case 0..<12:
                joinCount = Int.random(in: 480...1_900)
            case 12..<45:
                joinCount = Int.random(in: 320...1_300)
            case 45..<90:
                joinCount = Int.random(in: 220...880)
            case 90..<180:
                joinCount = Int.random(in: 140...560)
            default:
                joinCount = Int.random(in: 90...380)
            }
        } else if purchasedAudienceCount > 0 {
            switch streamTime {
            case 0..<12:
                joinCount = Int.random(in: 420...1_800)
            case 12..<45:
                joinCount = Int.random(in: 280...1_250)
            case 45..<90:
                joinCount = Int.random(in: 180...850)
            case 90..<180:
                joinCount = Int.random(in: 110...520)
            default:
                joinCount = Int.random(in: 35...180)
            }
        } else if isAudienceBoostActive {
            joinCount = streamTime < 180 ? Int.random(in: 240...1_200) : Int.random(in: 80...520)
        } else if popularity >= 10_000 {
            switch streamTime {
            case 0..<15:
                joinCount = Int.random(in: 380...1_500)
            case 15..<45:
                joinCount = Int.random(in: 260...980)
            case 45..<90:
                joinCount = Int.random(in: 140...620)
            case 90..<180:
                joinCount = Int.random(in: 80...360)
            default:
                joinCount = Int.random(in: 5...22)
            }
        } else {
            switch streamTime {
            case 0..<12:
                joinCount = Int.random(in: 300...900)
            case 12..<45:
                joinCount = Int.random(in: 220...700)
            case 45..<90:
                joinCount = Int.random(in: 150...480)
            case 90..<180:
                joinCount = Int.random(in: 90...320)
            case 180..<600:
                joinCount = Int.random(in: 12...58)
            default:
                let currentScale = max(1, min(8, popularity / 4_000))
                joinCount = Int.random(in: 8...(34 + currentScale * 18))
            }
        }

        popularity = min(popularityCeiling, popularity + joinCount)
        audienceEnergy = min(1.0, audienceEnergy + Double.random(in: 0.006...0.018))

        guard preferences.commentsEnabled, !isDeepAnswerVisible || preferences.isPremiumMember else { return }
        let shouldShowJoinMessage: Bool
        if streamTime < 15 {
            shouldShowJoinMessage = openingAudienceWaves <= 3 || openingAudienceWaves.isMultiple(of: 2)
        } else if streamTime < 45 {
            shouldShowJoinMessage = openingAudienceWaves.isMultiple(of: 2)
        } else if streamTime < 180 {
            shouldShowJoinMessage = openingAudienceWaves.isMultiple(of: 3)
        } else if preferences.isPremiumMember {
            shouldShowJoinMessage = openingAudienceWaves.isMultiple(of: 2) || Int.random(in: 0...100) < 42
        } else {
            shouldShowJoinMessage = openingAudienceWaves <= 18
                || openingAudienceWaves.isMultiple(of: Int.random(in: 2...4))
                || isAudienceBoostActive
        }
        if shouldShowJoinMessage {
            appendViewerJoinComment()
        }
        let barrageWaveInterval = preferences.isPremiumMember ? (streamTime < 45 ? 4 : 5) : (streamTime < 45 ? 4 : (streamTime < 180 ? 5 : 8))
        if openingAudienceWaves.isMultiple(of: barrageWaveInterval) {
            appendBarrageComment()
        }
    }

    private func scheduleNextBarrage(initialDelay: Bool = false) {
        commentTimer?.invalidate()
        let interval = initialDelay ? Double.random(in: 0.8...1.5) : nextBarrageInterval()
        commentTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { timer in
            timer.invalidate()
            if isRecording && preferences.commentsEnabled {
                appendBarrageComment()
            }
            scheduleNextBarrage()
        }
    }

    private func nextBarrageInterval() -> Double {
        if streamTime < 180 {
            if deepAnswerInFlight {
                return Double.random(in: 1.6...2.8)
            }
            return Double.random(in: 0.9...1.8)
        }

        if isDeepAnswerVisible {
            if preferences.isPremiumMember {
                return Double.random(in: 1.4...2.5)
            }
            return Double.random(in: 3.0...4.6)
        }

        if isAudienceBoostActive {
            return Double.random(in: 1.2...2.4)
        }

        if deepAnswerInFlight {
            if preferences.isPremiumMember {
                return Double.random(in: 1.8...3.0)
            }
            return Double.random(in: 3.0...4.8)
        }

        if streamTime - lastDeepAnswerTime < 18 {
            if preferences.isPremiumMember {
                return Double.random(in: 1.6...2.8)
            }
            return Double.random(in: 3.0...4.8)
        }

        if preferences.isPremiumMember {
            return Double.random(in: 1.2...2.4)
        }

        if streamTime < 45 {
            return Double.random(in: 1.0...1.8)
        }
        if streamTime < 180 {
            return Double.random(in: 1.6...2.8)
        }

        switch popularity {
        case 120_000...:
            return Double.random(in: 1.8...3.2)
        case 50_000...:
            return Double.random(in: 2.2...3.8)
        case 10_000...:
            return Double.random(in: 2.8...4.8)
        default:
            return streamTime > 240 ? Double.random(in: 3.0...4.5) : Double.random(in: 2.8...4.2)
        }
    }

    private func appendBarrageComment() {
        let item: (String, String, String)
        if let vibeComment = selectedVibeComment() {
            item = vibeComment
        } else if openingCommentIndex < openingComments.count {
            item = openingComments[openingCommentIndex]
            openingCommentIndex += 1
        } else {
            let contextualComment = contextualBarrageComment()
            item = contextualComment.2 == lastBarrageCommentText
                ? aiComments.filter { $0.2 != lastBarrageCommentText }.randomElement() ?? contextualComment
                : contextualComment
        }
        lastBarrageCommentText = item.2
        lastRobotActivityTime = streamTime

        let comment = ChatComment(name: item.0, avatar: item.1, text: item.2, kind: .barrage)
        rememberChatComment(comment)
        withAnimation {
            comments.append(comment)
            trimLiveComments(maxRobotComments: 3)
        }
        expireComment(comment.id, after: 4.8)
    }

    private func appendViewerJoinComment() {
        let item = viewerJoinComments.randomElement() ?? viewerJoinComments[0]
        let comment = ChatComment(name: item.0, avatar: item.1, text: item.2, kind: .barrage)
        lastRobotActivityTime = streamTime
        rememberChatComment(comment)
        withAnimation {
            comments.append(comment)
            trimLiveComments(maxRobotComments: 3)
        }
        expireComment(comment.id, after: 4.2)
    }

    private func ensureAudienceContinuity() {
        guard preferences.commentsEnabled,
              isRecording else { return }

        if visibleLiveComments.isEmpty {
            appendViewerJoinComment()
            scheduleNextBarrage()
            return
        }

        guard streamTime - lastRobotActivityTime >= maximumRobotSilence else { return }

        if streamTime.isMultiple(of: 2) {
            appendViewerJoinComment()
        } else {
            appendBarrageComment()
        }
        scheduleNextBarrage()
    }

    private var maximumRobotSilence: Int {
        if preferences.isPremiumMember {
            return 3
        }
        guard shouldApplyLowCoinAudienceDecay, streamTime >= lowCoinAudienceDecayStart else {
            return 5
        }
        let progress = min(1, max(0, Double(streamTime - lowCoinAudienceDecayStart) / Double(lowCoinAudienceDecayDuration)))
        return 5 + Int((progress * 3).rounded())
    }

    private var popularityCeiling: Int {
        if let target = audienceTargetPopularity {
            return min(500_000, max(target, floatingAudienceCenter) + audienceFluctuationRadius)
        }
        return min(500_000, floatingAudienceCenter + audienceFluctuationRadius)
    }

    private var visibleLiveComments: [ChatComment] {
        let latestDeepAnswer = latestDisplayedDeepAnswerID.flatMap { displayedID in
            comments.first { $0.id == displayedID && $0.kind == .deepAnswer && $0.text != "•••" }
        }
        let latestRobotComments = comments
            .filter { $0.kind != .deepAnswer }
            .suffix(2)

        if let latestDeepAnswer {
            return [latestDeepAnswer] + Array(latestRobotComments)
        }

        if let placeholder = comments.last(where: { $0.kind == .deepAnswer && $0.text == "•••" }) {
            return [placeholder] + Array(latestRobotComments)
        }

        return Array(comments.filter { $0.kind != .deepAnswer }.suffix(3))
    }

    private var popularityFloor: Int {
        if streamTime < baselineRampDuration && popularity < baselinePopularityTarget {
            return max(50, Int(Double(initialPopularity) * 0.72))
        }
        return max(50, floatingAudienceCenter - audienceFluctuationRadius)
    }

    private var organicPopularityTarget: Int {
        let seconds = Double(streamTime)
        let slowWave = sin(seconds / 18.0) * 0.62
        let quickWave = sin(seconds / 5.5) * 0.18
        let energyBias = min(0.12, max(-0.12, audienceEnergy - 0.54))
        let offset = Double(audienceFluctuationRadius) * (slowWave + quickWave + energyBias)
        let target = floatingAudienceCenter + Int(offset)
        return min(popularityCeiling, max(popularityFloor, target))
    }

    private var baselinePopularityTarget: Int {
        preferences.isPremiumMember ? 300_000 : 50_000
    }

    private var baselineRampDuration: Int {
        preferences.isPremiumMember ? 90 : 75
    }

    private var purchasedAudienceProgress: Double {
        guard purchasedAudienceCount > 0 else { return 0 }
        let duration = max(60, Int(audienceArrivalMinutes * 60))
        return min(1, Double(streamTime) / Double(duration))
    }

    private var floatingAudienceCenter: Int {
        let baseline = baselinePopularityTarget + Int(Double(purchasedAudienceCount) * purchasedAudienceProgress)
        guard shouldApplyLowCoinAudienceDecay else {
            return min(500_000, baseline)
        }

        let decayProgress = min(1, max(0, Double(streamTime - lowCoinAudienceDecayStart) / Double(lowCoinAudienceDecayDuration)))
        let target = max(50, preferences.lobbyJoinCount)
        return max(target, Int(Double(baseline) * (1 - decayProgress) + Double(target) * decayProgress))
    }

    private var audienceFluctuationRadius: Int {
        if shouldApplyLowCoinAudienceDecay {
            return max(12, min(5_000, floatingAudienceCenter / 8))
        }
        if preferences.isPremiumMember {
            return min(50_000, max(15_000, floatingAudienceCenter / 10))
        }
        return 5_000
    }

    private var shouldApplyLowCoinAudienceDecay: Bool {
        !preferences.isPremiumMember && coins < 100 && !hasManualAudienceAdditions
    }

    private let lowCoinAudienceDecayStart = 600
    private let lowCoinAudienceDecayDuration = 300

    private func nextPopularityDelta() -> Int {
        let scale = max(0.65, min(18.0, Double(max(popularity, initialPopularity)) / 5_000.0))
        if let target = audienceTargetPopularity, target > popularity {
            let remaining = target - popularity
            let roll = Int.random(in: 0...100)
            if roll < 14 {
                return -Int(Double.random(in: 8...38) * max(1.0, min(6.0, scale)))
            }
            let remainingTicks = max(1, (audienceBoostUntil - streamTime) / 2)
            let plannedStep = max(24, min(20_000, remaining / remainingTicks))
            return plannedStep + Int.random(in: -24...120)
        }

        let organicTarget = organicPopularityTarget
        if organicTarget > popularity {
            let remaining = organicTarget - popularity
            let roll = Int.random(in: 0...100)
            if roll < 12 {
                return -Int(Double.random(in: 5...24) * min(4.0, scale))
            }
            if streamTime < baselineRampDuration && popularity < baselinePopularityTarget {
                let remainingToBaseline = baselinePopularityTarget - popularity
                let remainingTicks = max(1, (baselineRampDuration - streamTime) / 2)
                let maximumStep = preferences.isPremiumMember ? 12_000 : 1_800
                let plannedStep = max(80, min(maximumStep, remainingToBaseline / remainingTicks))
                let jitter = max(12, plannedStep / 10)
                return plannedStep + Int.random(in: -jitter...jitter)
            }
            let plannedStep = max(18, min(streamTime < 180 ? 520 : 240, remaining / (streamTime < 240 ? 16 : 34)))
            return plannedStep + Int.random(in: 0...80)
        }

        if organicTarget < popularity {
            let distance = popularity - organicTarget
            let maximumStep: Int
            if shouldApplyLowCoinAudienceDecay && streamTime >= lowCoinAudienceDecayStart {
                maximumStep = 180
            } else {
                maximumStep = preferences.isPremiumMember ? 2_400 : 620
            }
            let plannedStep = max(18, min(maximumStep, distance / 5))
            let jitter = max(8, plannedStep / 5)
            return -plannedStep + Int.random(in: -jitter...jitter)
        }

        if popularity >= 10_000 {
            let movementUnit = max(20, audienceFluctuationRadius / 45)
            return Int.random(in: -movementUnit...movementUnit)
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
            return chatAvatarURLMap[comment.name] ?? listener.imageURL
        }

        if comment.kind == .userSpeech {
            return nil
        }

        if let mappedURL = chatAvatarURLMap[comment.name] {
            return mappedURL
        }

        let fallbackIndex = stableIndex(for: comment.name, count: AICompanionCatalog.friends.count)
        return AICompanionCatalog.friends[safe: fallbackIndex]?.imageURL
    }

    private var chatAvatarURLMap: [String: String] {
        var avatarURLs = commentAvatarURLMap
        for activeListener in activeAIListeners {
            avatarURLs[activeListener.name] = activeListener.imageURL
        }
        return avatarURLs
    }

    private func isPremiumComment(_ comment: ChatComment) -> Bool {
        comment.avatar == "🎁" || ["Emma", "Lily", "Ryan", "Zoe"].contains(comment.name)
    }

    private func contextualBarrageComment() -> (String, String, String) {
        let transcript = speechTranscriber.transcript.lowercased()

        if let vibeComment = selectedVibeComment() {
            return vibeComment
        }

        if transcript.contains("sad") || transcript.contains("tired") || transcript.contains("stress") || transcript.contains("worried") {
            return [("Sofia", "👱‍♀️", "That sounds heavy, but you are saying it clearly."), ("Emma", "👩", "We are staying with you through this.")].randomElement() ?? aiComments[0]
        }

        if transcript.contains("happy") || transcript.contains("excited") || transcript.contains("proud") {
            return [("Zoe", "👩‍🦱", "That joy is showing on your face."), ("Ryan", "👨‍🦰", "This is the energy we came for.")].randomElement() ?? aiComments[0]
        }

        let activeDirections = liveToneTopics.map { $0.lowercased() }
        let direction = activeDirections.randomElement() ?? "general"
        return commentsForDirection(direction).randomElement() ?? aiComments[0]
    }

    private func selectedVibeComment() -> (String, String, String)? {
        let supportedVibes = ["Haters", "Hype", "Happy", "Flirty", "Funny", "Curious"]
        let activeVibes = liveVibeMoods.filter { supportedVibes.contains($0) }
        guard !activeVibes.isEmpty else { return nil }
        let selectedVibe = activeVibes.contains("Haters") ? "Haters" : activeVibes.randomElement() ?? "Hype"
        let contentPool = expandedCommentsForVibe(selectedVibe)
        let unusedCandidates = contentPool.filter {
            $0.2 != lastBarrageCommentText && !usedVibeCommentTexts.contains($0.2)
        }
        if let selected = unusedCandidates.randomElement() {
            usedVibeCommentTexts.insert(selected.2)
            return viewerIdentity(for: selected)
        }

        guard let base = commentsForVibe(selectedVibe).randomElement() else { return nil }
        let overflowText = "\(base.2) \(String(repeating: "·", count: max(1, usedVibeCommentTexts.count / max(contentPool.count, 1) + 1)))"
        usedVibeCommentTexts.insert(overflowText)
        return viewerIdentity(for: (base.0, base.1, overflowText))
    }

    private func viewerIdentity(for comment: (String, String, String)) -> (String, String, String) {
        guard !AICompanionCatalog.friends.isEmpty else { return comment }
        let hash = comment.2.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) }
        var index = abs(hash + usedVibeCommentTexts.count) % AICompanionCatalog.friends.count
        if AICompanionCatalog.friends[index].name == lastVibeCommentName {
            index = (index + 1) % AICompanionCatalog.friends.count
        }
        let friend = AICompanionCatalog.friends[index]
        lastVibeCommentName = friend.name
        return (friend.name, friend.emoji, comment.2)
    }

    private func expandedCommentsForVibe(_ vibe: String) -> [(String, String, String)] {
        let baseComments = commentsForVibe(vibe)
        let suffixes: [String]
        let decorations: [String]

        switch vibe {
        case "Haters":
            suffixes = ["", " Be serious.", " Convince me.", " The chat noticed too.", " I said what I said.", " That is still not adding up.", " Try that explanation again.", " Someone had to say it.", " I am not letting that slide.", " The room needs a better answer."]
            decorations = ["", " 😒", " 🙄", " 👀", " 🤨", " 🫤"]
        case "Hype":
            suffixes = ["", " Keep going!", " The room agrees!", " This deserves a replay!", " Do not slow down now!", " Everyone is locked in!", " That was a moment!", " The energy is climbing!", " We need more of this!", " The whole chat felt that!"]
            decorations = ["", " 🔥", " 🚀", " 🙌", " ⚡️", " 👑"]
        case "Happy":
            suffixes = ["", " This feels so good.", " The room needed that.", " Keep this energy around.", " What a sweet moment.", " This made me smile.", " Everyone feels lighter now.", " The vibe is so warm.", " I love this for you.", " This is genuinely lovely."]
            decorations = ["", " 😊", " 💛", " 🌈", " 🫶", " ☀️"]
        case "Flirty":
            suffixes = ["", " You know what you are doing.", " That was dangerously smooth.", " The eye contact is working.", " Now the room is blushing.", " You cannot just do that casually.", " That charm is very intentional.", " I almost forgot what you were saying.", " The camera definitely noticed.", " This is getting personal."]
            decorations = ["", " 😏", " 😘", " 💘", " 🫠", " 🌹"]
        case "Funny":
            suffixes = ["", " I cannot breathe.", " The timing was perfect.", " The chat is done for.", " That needs a replay.", " Nobody was ready for that.", " This story keeps getting better.", " Please do not make me laugh again.", " The delivery was everything.", " We are never forgetting this."]
            decorations = ["", " 😂", " 🤣", " 💀", " 😭", " 🍿"]
        case "Curious":
            suffixes = ["", " Tell us more.", " What happened next?", " I need the full story.", " Can you explain that part?", " What made you decide that?", " How did that change things?", " Which detail matters most?", " What would you do now?", " Where did that begin?"]
            decorations = ["", " 🤔", " 👀", " 🧐", " 💭", " 🔍"]
        default:
            suffixes = [""]
            decorations = [""]
        }

        var expanded: [(String, String, String)] = []
        expanded.reserveCapacity(baseComments.count * suffixes.count * decorations.count)
        for comment in baseComments {
            for suffix in suffixes {
                for decoration in decorations {
                    expanded.append((comment.0, comment.1, comment.2 + suffix + decoration))
                }
            }
        }
        return expanded
    }

    private func commentsForVibe(_ vibe: String) -> [(String, String, String)] {
        switch vibe {
        case "Haters":
            return [
                ("Blake", "😒", "That explanation is not convincing me."),
                ("Jordan", "🙄", "You are stretching that point pretty far."),
                ("Casey", "🫤", "Not everyone in here is buying this take."),
                ("Drew", "😑", "The confidence is stronger than the argument."),
                ("Morgan", "👀", "You skipped the part that actually matters."),
                ("Taylor", "😬", "That probably sounded better in your head."),
                ("Cameron", "🤨", "Bold claim, but the evidence is missing."),
                ("Reese", "🫢", "The room is being polite, so I will say no."),
                ("Parker", "🥱", "I am still waiting for the actual point."),
                ("Quinn", "🧐", "That story has a few holes in it."),
                ("Avery", "😏", "You really thought nobody would question that?"),
                ("Rowan", "🧊", "This take is colder than the comment section.")
            ]
        case "Hype":
            return [
                ("Zoe", "🔥", "Okay, the energy just went all the way up!"),
                ("Ken", "🙌", "The whole room is locked in right now!"),
                ("Mia", "🚀", "This is the moment—keep going!"),
                ("Noah", "👑", "Main-character energy is fully activated."),
                ("Sophia", "💥", "That point deserved a bigger audience!"),
                ("Ivy", "⚡️", "You are absolutely owning this live!"),
                ("Sam", "📣", "Everybody wake up, this stream is taking off!"),
                ("Leo", "🌟", "That was a highlight moment for sure!"),
                ("Ava", "🏆", "You came prepared to win today."),
                ("Ethan", "💪", "Keep that momentum—this is working!"),
                ("Chloe", "✨", "The confidence is filling the whole screen!"),
                ("Luna", "🎉", "This room just found its favorite creator!")
            ]
        case "Happy":
            return [
                ("Emma", "😊", "This live is making my day better."),
                ("Lily", "🌈", "The room feels so cheerful right now."),
                ("Chloe", "🥰", "Your smile is genuinely contagious."),
                ("Harper", "☀️", "This is such a warm little moment."),
                ("Nora", "💛", "I love how comfortable this feels."),
                ("Olivia", "🌸", "The positive energy is coming through clearly."),
                ("Mia", "😄", "I joined at exactly the right time."),
                ("Ava", "🫶", "This feels like hanging out with a good friend."),
                ("Sophia", "💖", "Everyone looks happier after that."),
                ("Luna", "🌼", "This vibe is soft, bright, and easy to enjoy."),
                ("Zoe", "🎈", "You just lifted the whole comment section."),
                ("Ivy", "😁", "I cannot stop smiling at this live.")
            ]
        case "Flirty":
            return [
                ("Sofia", "😘", "That smile is making it hard to scroll away."),
                ("Ryan", "😏", "You know exactly what that camera angle is doing."),
                ("Mia", "💋", "Okay, who gave you permission to look this good?"),
                ("Noah", "🫠", "The eye contact is a little too powerful today."),
                ("Chloe", "💕", "You are being dangerously charming right now."),
                ("Ethan", "😉", "I was going to leave, then you smiled."),
                ("Ava", "💘", "That voice could keep the whole room here."),
                ("Leo", "🌹", "The camera chemistry is definitely working."),
                ("Luna", "🥰", "You make this feel unexpectedly personal."),
                ("Jordan", "😍", "Not me getting shy through a screen."),
                ("Harper", "🫶", "That little look at the camera was unfair."),
                ("Zoe", "🔥", "The flirting level just changed the room temperature.")
            ]
        case "Funny":
            return [
                ("Riley", "😂", "I was not ready for that plot twist."),
                ("Jake", "🤣", "The delivery made this ten times funnier."),
                ("Sam", "💀", "I just opened the app and immediately lost it."),
                ("Mia", "😹", "Please, the confidence before the chaos!"),
                ("Noah", "🍿", "I brought snacks because this story has episodes."),
                ("Lily", "😂", "The pause before that sentence was perfect."),
                ("Alex", "🤡", "We are all pretending that made complete sense."),
                ("Zoe", "😭", "Why is this accidentally the funniest live today?"),
                ("Ethan", "😆", "That needs to become an inside joke immediately."),
                ("Chloe", "🙈", "I laughed before you even finished the sentence."),
                ("Leo", "🎭", "This live has better timing than most comedy shows."),
                ("Ivy", "🤣", "The comment section is never recovering from that.")
            ]
        case "Curious":
            return [
                ("Ava", "🤔", "What made you think about that today?"),
                ("Noah", "🧐", "What happened immediately after that?"),
                ("Nora", "💭", "Which part matters most to you personally?"),
                ("Harper", "👀", "Can you show us what you mean?"),
                ("Leo", "🧠", "Did your opinion change over time?"),
                ("Emma", "❓", "How did you feel when that happened?"),
                ("Ethan", "🔍", "What would you do differently next time?"),
                ("Luna", "🌙", "Is there more to the story than we know?"),
                ("Sophia", "💬", "What answer are you hoping to find?"),
                ("Ryan", "🗣️", "Who else was involved in that moment?"),
                ("Chloe", "✨", "What is the one detail we should notice?"),
                ("Ivy", "📝", "Can you walk us through it from the beginning?")
            ]
        default:
            return aiComments
        }
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
        let cleanTranscript = speechTranscriber.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isMeaningfulSpeech(cleanTranscript) else { return }
        guard cleanTranscript != lastProcessedTranscript else { return }
        if let languageCode = speechTranscriber.applyLanguageCommand(from: cleanTranscript) {
            lastProcessedTranscript = cleanTranscript
            appendUserSpeechIfNeeded(cleanTranscript)
            appendDeepAnswer(languageSwitchAcknowledgement(for: languageCode), from: listener)
            return
        }
        guard streamTime - lastDeepAnswerTime >= voiceReplyCooldown else { return }

        let newSegment: String
        if !lastProcessedTranscript.isEmpty, cleanTranscript.hasPrefix(lastProcessedTranscript) {
            newSegment = String(cleanTranscript.dropFirst(lastProcessedTranscript.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            newSegment = cleanTranscript
        }
        let prompt = isMeaningfulSpeech(newSegment) ? newSegment : cleanTranscript

        lastProcessedTranscript = cleanTranscript
        guard shouldAcceptSpeechPrompt(prompt) else { return }
        reportUserInteractionIfNeeded(type: "user_spoke")
        guard !deepAnswerInFlight else {
            enqueueDeepPrompt(prompt)
            return
        }
        requestDeepAnswer(for: prompt, inputLanguageOverride: speechTranscriber.detectedLanguageCode)
    }

    private func sendLiveToolPrompt(_ promptText: String) {
        let prompt = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        if let languageCode = speechTranscriber.applyLanguageCommand(from: prompt) {
            appendUserSpeechIfNeeded(prompt)
            appendDeepAnswer(languageSwitchAcknowledgement(for: languageCode), from: listener)
            return
        }
        reportUserInteractionIfNeeded(type: "user_typed")
        guard streamTime - lastDeepAnswerTime >= minimumAIReplyInterval else {
            liveToolMessage = "Free AI activity gradually slows after ten minutes when your balance is below 100 coins. Subscribe to PRO or add coins for frequent dynamic replies."
            return
        }
        guard !deepAnswerInFlight else {
            enqueueDeepPrompt(prompt)
            return
        }
        requestDeepAnswer(for: prompt)
    }

    private func scheduleSpeechReply() {
        let text = speechTranscriber.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasCJK = text.unicodeScalars.contains { (0x3400...0x9FFF).contains(Int($0.value)) }
        let wordCount = text.split(whereSeparator: { $0.isWhitespace }).count
        let delay: TimeInterval
        if hasCJK {
            delay = text.count < 7 ? 0.68 : 0.48
        } else {
            delay = wordCount < 4 ? 0.82 : 0.58
        }
        scheduleSpeechReply(after: delay)
    }

    private func scheduleSpeechReply(after delay: TimeInterval) {
        guard isRecording else { return }
        speechReplyTimer?.invalidate()
        speechReplyTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { timer in
            timer.invalidate()
            speechReplyTimer = nil
            maybeRequestDeepAnswer()
        }
    }

    private func handleVisualContextChange(_ context: String) {
        let cleanContext = context.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isRecording,
              cleanContext.count >= 24,
              cleanContext != lastVisualAIContext,
              streamTime - lastVisualAIReactionTime >= 14,
              !deepAnswerInFlight else { return }

        lastVisualAIContext = cleanContext
        lastVisualAIReactionTime = streamTime
        let prompt = "React naturally and briefly to the latest visible action or scene change. Only mention details supported by the visual context. If nothing meaningful changed, ask one relevant question instead."
        requestDeepAnswer(
            for: prompt,
            remembersPrompt: false,
            inputLanguageOverride: speechTranscriber.detectedLanguageCode
        )
    }

    private func requestDeepAnswer(for prompt: String, remembersPrompt: Bool = true, inputLanguageOverride: String? = nil) {
        deepAnswerInFlight = true
        if remembersPrompt {
            appendUserSpeechIfNeeded(prompt)
        }
        let requestStartedAt = Date()
        SquadLiveAnalytics.log("ai_reply_requested", parameters: [
            "live_seconds": streamTime,
            "membership_tier": preferences.isPremiumMember ? "pro" : "free"
        ])
        let requestID = UUID()
        activeDeepRequestID = requestID
        let ordered = orderedResponders()
        let selectedCount = responderCount(for: prompt, remembersPrompt: remembersPrompt)
        let responders = Array(ordered.prefix(selectedCount))
        let memorySnapshot = conversationMemories
        if !responders.isEmpty, !activeAIListeners.isEmpty {
            nextResponderIndex = (nextResponderIndex + responders.count) % activeAIListeners.count
        }
        lastDeepAnswerTime = streamTime

        Task {
            var successfulReplies = 0

            for (index, responder) in responders.enumerated() {
                let provisionalCommentID = await MainActor.run {
                    appendDeepAnswer("•••", from: responder, displayDuration: 180)
                }

                let result = await DeepSeekClient.answer(
                    userText: prompt,
                    history: memorySnapshot[responder.id] ?? [],
                    userName: userName,
                    listener: responder,
                    roleMode: aiRoleMode,
                    replyDepth: aiReplyDepth,
                    activeDirections: liveToneTopics,
                    toneTopics: liveToneTopics,
                    vibeMoods: liveVibeMoods,
                    liveSeconds: streamTime,
                    sceneContext: cameraRecorder.sceneContext,
                    inputLanguageOverride: inputLanguageOverride,
                    interactionType: remembersPrompt ? "user" : "system_opening"
                )

                let didSucceed = await MainActor.run { () -> Bool in
                    guard activeDeepRequestID == requestID, isRecording else { return false }
                    if let result, !result.text.isEmpty {
                        if let provisionalCommentID {
                            replaceDeepAnswer(provisionalCommentID, with: result.text, from: responder)
                        } else {
                            appendDeepAnswer(result.text, from: responder)
                        }
                        if remembersPrompt {
                            rememberConversation(userText: prompt, assistantText: result.text, for: responder)
                        } else {
                            var memory = conversationMemories[responder.id] ?? []
                            memory.append(DeepSeekMessage(role: "assistant", content: result.text))
                            conversationMemories[responder.id] = Array(memory.suffix(12))
                        }
                        return true
                    }
                    removeDeepAnswer(provisionalCommentID)
                    return false
                }
                if didSucceed {
                    successfulReplies += 1
                    await MainActor.run {
                        reportAIReplyIfNeeded()
                    }
                }

                if index < responders.count - 1 {
                    try? await Task.sleep(for: .milliseconds(420))
                }
            }

            await MainActor.run {
                guard activeDeepRequestID == requestID else { return }
                activeDeepRequestID = nil
                deepAnswerInFlight = false
                guard isRecording else { return }

                if successfulReplies == 0 {
                    let fallbackResponder = responders.first ?? listener
                    let fallbackText = localDeepAnswer(for: prompt)
                    appendDeepAnswer(fallbackText, from: fallbackResponder)
                    reportAIReplyIfNeeded()
                    if remembersPrompt {
                        rememberConversation(userText: prompt, assistantText: fallbackText, for: fallbackResponder)
                    }
                }

                SquadLiveAnalytics.log("ai_reply_completed", parameters: [
                    "reply_count": max(1, successfulReplies),
                    "used_fallback": successfulReplies == 0 ? 1 : 0,
                    "latency_ms": Int(Date().timeIntervalSince(requestStartedAt) * 1_000),
                    "live_seconds": streamTime
                ])

                lastDeepAnswerTime = streamTime
                if !pendingDeepPrompts.isEmpty {
                    let delay = max(0, voiceReplyCooldown)
                    DispatchQueue.main.asyncAfter(deadline: .now() + Double(delay)) {
                        guard isRecording, !deepAnswerInFlight, !pendingDeepPrompts.isEmpty else { return }
                        let nextPrompt = pendingDeepPrompts.removeFirst()
                        requestDeepAnswer(for: nextPrompt)
                    }
                } else if speechTranscriber.transcript.trimmingCharacters(in: .whitespacesAndNewlines) != lastProcessedTranscript {
                    scheduleSpeechReply(after: 0.7)
                }
            }
        }
    }

    private func requestOpeningAIGreetingIfNeeded() {
        guard isRecording,
              !hasRequestedOpeningGreeting,
              !deepAnswerInFlight,
              !hasConversationMemory,
              speechTranscriber.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        hasRequestedOpeningGreeting = true
        let greeting = "Hey \(userName)! I’m listening 💜 What do you feel like talking about today?"
        appendDeepAnswer(greeting, from: listener, displayDuration: 50)
        reportAIReplyIfNeeded()
    }

    private func requestSilentUserNudgeIfNeeded() {
        guard isRecording,
              !hasReportedUserInteraction,
              silentUserNudgeCount < 2,
              !deepAnswerInFlight,
              speechTranscriber.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        silentUserNudgeCount += 1
        let prompt: String
        if silentUserNudgeCount == 1 {
            prompt = "The streamer is still quiet. As a friendly live-room companion, gently offer three easy topics they could talk about right now without sounding pushy."
        } else {
            prompt = "The streamer still seems shy. Briefly reassure them that they can share one tiny thing from today and you will carry the conversation forward."
        }
        requestDeepAnswer(for: prompt, remembersPrompt: false)
    }

    private func reportUserInteractionIfNeeded(type: String) {
        guard !hasReportedUserInteraction else { return }
        hasReportedUserInteraction = true
        Task { await LiveEngagementClient.report(type: type, sessionId: liveEngagementSessionID) }
    }

    private func reportAIReplyIfNeeded() {
        guard !hasReportedAIReply else { return }
        hasReportedAIReply = true
        Task { await LiveEngagementClient.report(type: "ai_reply_displayed", sessionId: liveEngagementSessionID) }
    }

    private var liveAIStatusText: String? {
        if deepAnswerInFlight {
            return "Your AI friends are replying..."
        }
        if speechTranscriber.statusText.contains("not enabled")
            || speechTranscriber.statusText.contains("unavailable")
            || speechTranscriber.statusText.contains("reconnecting") {
            return speechTranscriber.statusText
        }
        if streamTime < 24 && !hasConversationMemory {
            return "Your AI friends are listening..."
        }
        return nil
    }

    private var isSpeechRecognitionUnavailable: Bool {
        let status = speechTranscriber.statusText.lowercased()
        return status.contains("unavailable") || status.contains("not enabled") || status.contains("reconnecting")
    }

    private func isMeaningfulSpeech(_ text: String) -> Bool {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return false }
        let lowercased = clean.lowercased()
        let words = lowercased.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        let nonLatinCount = text.unicodeScalars.filter {
            CharacterSet.letters.contains($0) && $0.value > 127
        }.count
        if nonLatinCount >= 2 { return true }
        if clean.contains("?") || clean.contains("？") { return words.count >= 2 }

        let shortIntentPhrases = [
            "i love you", "love you", "thank you", "thanks", "hello there", "help me",
            "i am sad", "i'm sad", "i feel sad", "not good", "feel bad", "i am happy", "i'm happy"
        ]
        if shortIntentPhrases.contains(where: { lowercased.contains($0) }) { return true }

        let fillerWords: Set<String> = [
            "yes", "yeah", "yep", "okay", "ok", "good", "right", "well", "um", "uh", "like", "so",
            "the", "a", "an", "and", "but", "it", "this", "that", "really", "very"
        ]
        let meaningfulWords = words.filter { !fillerWords.contains($0) && $0.count > 1 }
        return words.count >= 2 && !meaningfulWords.isEmpty
    }

    private func shouldAcceptSpeechPrompt(_ prompt: String) -> Bool {
        let key = normalizedSpeechKey(prompt)
        guard key.count >= 2 else { return false }

        let now = Date().timeIntervalSinceReferenceDate
        recentSpeechPromptTimes = recentSpeechPromptTimes.filter { now - $0.value < 30 }
        guard recentSpeechPromptTimes[key] == nil else { return false }
        recentSpeechPromptTimes[key] = now
        return true
    }

    private func normalizedSpeechKey(_ text: String) -> String {
        let folded = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return String(folded.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
    }

    private func enqueueDeepPrompt(_ prompt: String) {
        guard !prompt.isEmpty, pendingDeepPrompts.last != prompt else { return }
        pendingDeepPrompts.append(prompt)
        pendingDeepPrompts = Array(pendingDeepPrompts.suffix(8))
    }

    private func rememberConversation(userText: String, assistantText: String, for responder: Listener) {
        var memory = conversationMemories[responder.id] ?? []
        memory.append(DeepSeekMessage(role: "user", content: userText))
        memory.append(DeepSeekMessage(role: "assistant", content: assistantText))
        conversationMemories[responder.id] = Array(memory.suffix(12))
    }

    @ViewBuilder
    private var liveFilterEffect: some View {
        ZStack {
            if selectedFilter != "None" {
                Text(filterEmoji)
                    .font(.system(size: 108))
                    .shadow(color: filterGlowColor.opacity(0.82), radius: 16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .padding(.top, 86)
                    .accessibilityLabel("\(selectedFilter) live filter")
            }

            filterGlowColor
                .opacity(selectedFilter == "None" ? 0 : 0.10)
                .blendMode(.screen)
        }
        .allowsHitTesting(false)
    }

    private var filterEmoji: String {
        switch selectedFilter {
        case "Unicorn Mask": "🦄"
        case "Owl Mask": "🦉"
        case "Cyberpunk LED": "🤖"
        case "Cool Shades": "😎"
        case "Star Eyes": "⭐️"
        case "Cat Ears": "🐱"
        case "Bunny Mask": "🐰"
        case "Flower Crown": "🌸"
        case "Fire Aura": "🔥"
        default: ""
        }
    }

    private var filterGlowColor: Color {
        switch selectedFilter {
        case "Cyberpunk LED": .brandPurple
        case "Fire Aura": .brandOrange
        case "Flower Crown", "Unicorn Mask": .pink
        default: .white
        }
    }

    private func buyLiveViewers(viewers: Int, cost: Int) {
        guard !isBuyingLiveViewers else { return }

        isBuyingLiveViewers = true
        liveToolMessage = "Verifying coin balance..."
        let operationId: UUID
        if pendingLiveAudienceViewers == viewers, let pendingLiveAudienceOperationID {
            operationId = pendingLiveAudienceOperationID
        } else {
            operationId = UUID()
            pendingLiveAudienceOperationID = operationId
            pendingLiveAudienceViewers = viewers
        }
        Task { @MainActor in
            let result = await StoreBackendClient.commitAudiencePurchase(
                viewers: viewers,
                context: "live",
                operationId: operationId
            )
            isBuyingLiveViewers = false
            switch result {
            case .success(let balance, _, _, _):
                SquadLiveAnalytics.log("audience_purchase_completed", parameters: [
                    "viewers": viewers,
                    "context": "live",
                    "balance": balance
                ])
                pendingLiveAudienceOperationID = nil
                pendingLiveAudienceViewers = nil
                coins = balance
                showLiveToolPanel = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                    applyLiveViewerPurchase(viewers: viewers)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    onCoinsChanged(balance)
                }
            case .insufficient(let balance):
                SquadLiveAnalytics.log("audience_purchase_failed", parameters: [
                    "viewers": viewers,
                    "context": "live",
                    "reason": "insufficient_coins",
                    "balance": balance
                ])
                pendingLiveAudienceOperationID = nil
                pendingLiveAudienceViewers = nil
                coins = balance
                onCoinsChanged(balance)
                liveToolMessage = "Not enough coins. Recharge coins to add viewers."
            case .unavailable:
                SquadLiveAnalytics.log("audience_purchase_failed", parameters: [
                    "viewers": viewers,
                    "context": "live",
                    "reason": "server_unavailable"
                ])
                liveToolMessage = "Unable to verify coins. No coins were charged."
            }
        }
    }

    private func applyLiveViewerPurchase(viewers: Int) {
        cameraRecorder.pauseSceneAnalysis(for: 4)
        hasManualAudienceAdditions = true
        let target = min(500_000, popularity + viewers)
        let firstWave = min(max(Int(Double(viewers) * 0.10), 300), 10_000)
        popularity = min(target, popularity + firstWave)
        audienceTargetPopularity = target
        audienceBoostUntil = streamTime + max(150, min(480, viewers / 180))
        liveToolMessage = "\(viewers.formatted()) viewers are joining now."
        if !isDeepAnswerVisible {
            appendViewerJoinComment()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                if isRecording && preferences.commentsEnabled && isAudienceBoostActive {
                    appendViewerJoinComment()
                }
            }
        }
        if preferences.giftsEnabled {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) {
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

    @discardableResult
    private func appendDeepAnswer(_ text: String, from responder: Listener? = nil, displayDuration: Int = 36) -> UUID? {
        let normalizedAnswer = normalizedSpeechKey(text)
        if let lastAnswer = chatHistory.last(where: { $0.kind == .deepAnswer }),
           normalizedSpeechKey(lastAnswer.text) == normalizedAnswer,
           Date().timeIntervalSince(lastAnswer.createdAt) < 20 {
            return nil
        }
        deepAnswerVisibleUntil = streamTime + displayDuration
        let speaker = responder ?? listener
        let comment = ChatComment(name: speaker.name, avatar: speaker.avatar, text: text, kind: .deepAnswer)
        if text != "•••" {
            latestDisplayedDeepAnswerID = comment.id
        }
        rememberChatComment(comment)
        withAnimation {
            comments.append(comment)
            trimLiveComments(maxRobotComments: 3)
        }
        expireComment(comment.id, after: Double(displayDuration))
        return comment.id
    }

    private func replaceDeepAnswer(_ id: UUID, with text: String, from responder: Listener? = nil) {
        var isVisible = false
        if let index = comments.firstIndex(where: { $0.id == id }) {
            withAnimation(.easeInOut(duration: 0.22)) {
                comments[index].text = text
            }
            isVisible = true
            latestDisplayedDeepAnswerID = id
            deepAnswerVisibleUntil = max(deepAnswerVisibleUntil, streamTime + 36)
            expireComment(id, after: 36)
        }
        if let index = chatHistory.firstIndex(where: { $0.id == id }) {
            chatHistory[index].text = text
            LiveChatHistoryStore.save(chatHistory)
        }
        if !isVisible {
            appendDeepAnswer(text, from: responder)
        }
    }

    private func removeDeepAnswer(_ id: UUID?) {
        guard let id else { return }
        commentExpiryTokens[id] = nil
        if latestDisplayedDeepAnswerID == id {
            latestDisplayedDeepAnswerID = nil
        }
        withAnimation(.easeOut(duration: 0.22)) {
            comments.removeAll { $0.id == id }
        }
        chatHistory.removeAll { $0.id == id }
        LiveChatHistoryStore.save(chatHistory)
        DispatchQueue.main.async {
            ensureVisibleChatPresence()
        }
    }

    private var filteredChatHistory: [ChatComment] {
        chatHistory.filter { $0.kind == .deepAnswer || $0.kind == .userSpeech }
    }

    private func appendUserSpeechIfNeeded(_ text: String) {
        let normalized = normalizedSpeechKey(text)
        guard !normalized.isEmpty else { return }
        if let lastUserMessage = chatHistory.last(where: { $0.kind == .userSpeech }),
           normalizedSpeechKey(lastUserMessage.text) == normalized,
           Date().timeIntervalSince(lastUserMessage.createdAt) < 20 {
            return
        }

        let comment = ChatComment(name: userName, avatar: "🎙️", text: text, kind: .userSpeech)
        rememberChatComment(comment)
        withAnimation {
            comments.append(comment)
            trimLiveComments(maxRobotComments: 3)
        }
        expireComment(comment.id, after: 42)
    }

    private func languageSwitchAcknowledgement(for languageCode: String) -> String {
        switch languageCode {
        case "zh-Hans", "zh-Hant": return "好的，接下来我会用中文回复你。"
        case "es": return "Perfecto, a partir de ahora te responderé en español."
        case "fr": return "D’accord, je vais maintenant vous répondre en français."
        case "de": return "Alles klar, ich antworte dir ab jetzt auf Deutsch."
        case "ja": return "わかりました。これから日本語でお答えします。"
        case "ko": return "알겠어요. 이제부터 한국어로 답변할게요."
        case "pt": return "Certo, vou responder em português a partir de agora."
        case "it": return "Va bene, da ora in poi ti risponderò in italiano."
        case "ru": return "Хорошо, теперь я буду отвечать по-русски."
        case "ar": return "حسنًا، سأجيبك باللغة العربية من الآن."
        case "hi": return "ठीक है, अब से मैं आपको हिंदी में जवाब दूँगा।"
        case "th": return "ได้เลย ต่อไปนี้ฉันจะตอบเป็นภาษาไทย"
        case "vi": return "Được, từ bây giờ tôi sẽ trả lời bằng tiếng Việt."
        default: return "Got it. I’ll reply in English from now on."
        }
    }

    private func rememberChatComment(_ comment: ChatComment) {
        totalComments += 1
        chatHistory.append(comment)
        chatHistory = Array(chatHistory.suffix(240))
        if (comment.kind == .deepAnswer || comment.kind == .userSpeech) && comment.text != "•••" {
            LiveChatHistoryStore.save(chatHistory)
        }
    }

    private func trimLiveComments(maxRobotComments: Int) {
        let retainedRobotIDs = Set(
            comments
                .filter { $0.kind != .deepAnswer }
                .suffix(maxRobotComments)
                .map(\.id)
        )
        comments = comments.filter { comment in
            comment.kind == .deepAnswer || retainedRobotIDs.contains(comment.id)
        }
    }

    private var isDeepAnswerVisible: Bool {
        streamTime < deepAnswerVisibleUntil
    }

    private func expireComment(_ id: UUID?, after delay: Double) {
        guard let id else { return }
        let expiryToken = UUID()
        commentExpiryTokens[id] = expiryToken
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard commentExpiryTokens[id] == expiryToken else { return }
            commentExpiryTokens[id] = nil
            if latestDisplayedDeepAnswerID == id {
                latestDisplayedDeepAnswerID = nil
            }
            withAnimation(.easeOut(duration: 0.35)) {
                comments.removeAll { $0.id == id }
            }
            DispatchQueue.main.async {
                ensureVisibleChatPresence()
            }
        }
    }

    private func ensureVisibleChatPresence() {
        guard preferences.commentsEnabled,
              isRecording,
              visibleLiveComments.isEmpty else { return }
        appendViewerJoinComment()
        scheduleNextBarrage()
    }

    private func localDeepAnswer(for text: String) -> String {
        let lowercased = text.lowercased()
        switch DeepSeekClient.detectedLanguageCode(for: text) {
        case "zh-Hans", "zh-Hant": return "我听到了。可以再具体说一点吗？"
        case "ja": return "聞いています。もう少し詳しく教えてもらえますか？"
        case "ko": return "듣고 있어요. 조금 더 자세히 말해 주시겠어요?"
        case "es": return "Te escucho. ¿Puedes contarme un poco más?"
        case "fr": return "Je vous écoute. Pouvez-vous m’en dire un peu plus ?"
        case "de": return "Ich höre dir zu. Kannst du etwas mehr erzählen?"
        case "pt": return "Estou ouvindo. Pode contar um pouco mais?"
        case "ru": return "Я слушаю. Расскажите немного подробнее."
        case "ar": return "أنا أستمع إليك. هل يمكنك أن تخبرني بالمزيد؟"
        default: break
        }
        if let vibeReply = localVibeReply(for: text) {
            return vibeReply
        }
        if lowercased.contains("voice") || lowercased.contains("sound") || lowercased.contains("好听") {
            return "Your voice sounds warm and pleasant."
        }
        if lowercased.contains("pretty") || lowercased.contains("beautiful") || lowercased.contains("cute") || lowercased.contains("look") || lowercased.contains("好看") {
            return "You look great on camera today."
        }
        if lowercased.contains("stress") || lowercased.contains("worried") || lowercased.contains("anxious") {
            return "I hear the pressure. Start with one thing you can control."
        }
        if lowercased.contains("relationship") || lowercased.contains("friend") || lowercased.contains("family") {
            return "That sounds personal. Slow down and tell me more."
        }
        if lowercased.contains("我爱你") || lowercased.contains("喜欢你") || lowercased.contains("i love you") || lowercased.contains("love you") {
            return "That is really sweet. I’m glad I get to share this moment with you."
        }
        if lowercased.contains("谢谢") || lowercased.contains("thank you") || lowercased.contains("thanks") {
            return "You’re welcome. I’m right here with you."
        }
        if lowercased.contains("很高兴认识你") || lowercased.contains("认识你很高兴") || lowercased.contains("nice to meet you") || lowercased.contains("glad to meet you") {
            return "It’s really nice to meet you too. What would you like to talk about today?"
        }
        if lowercased.contains("summer") || lowercased.contains("夏天") {
            return "Summer has such a distinct energy. What do you enjoy most about it?"
        }
        if lowercased == "good" || lowercased.contains("i'm good") || lowercased.contains("i am good") || lowercased.contains("很好") {
            return "I’m glad to hear that. What made today feel good?"
        }
        if lowercased.contains("还是") || lowercased.contains("选择") || lowercased.contains("坚持") || lowercased.contains("放弃") || lowercased.contains("换一个") || lowercased.contains("choos") || lowercased.contains("between") || lowercased.contains("decision") || lowercased.contains("quit") {
            return "Compare each option's next-three-month upside, cost, and worst case. Do you value stability or growth more?"
        }
        if lowercased.contains("why") || lowercased.contains("how") || lowercased.contains("what") {
            return "That is a good question. Start with one concrete detail."
        }
        if text.contains("?") || text.contains("？") || lowercased.contains("怎么") || lowercased.contains("为什么") || lowercased.contains("怎么办") {
            return "Let's narrow it down: what have you tried, and which exact step is blocking you?"
        }
        let variants = [
            "That sounds worth unpacking. Which part would you like to solve first?",
            "I understand your point. What would a good outcome look like for you?",
            "Let’s stay with that. What matters most to you in this situation?"
        ]
        let hash = text.unicodeScalars.reduce(UInt(0)) { ($0 &* 31) &+ UInt($1.value) }
        let index = Int(hash % UInt(variants.count))
        return variants[index]
    }

    private func localVibeReply(for text: String) -> String? {
        let activeVibe = liveVibeMoods.contains("Haters")
            ? "Haters"
            : liveVibeMoods.randomElement()
        guard let activeVibe else { return nil }

        let variants: [String]
        switch activeVibe {
        case "Haters":
            variants = ["That is not convincing yet. Give me a more specific reason.", "I do not really agree—you skipped the most important part.", "That sounds bold, but the logic has not caught up yet."]
        case "Hype":
            variants = ["This topic fits you perfectly—keep going, the whole room is locked in!", "Your energy is fully switched on right now. Keep that pace!", "That line had real power. Take it one step further!"]
        case "Happy":
            variants = ["Hearing you say that genuinely lifts the mood. This feels really warm.", "You sound relaxed, and the whole room feels happier with you.", "This is such a comforting moment. Keep sharing at your own pace."]
        case "Flirty":
            variants = ["The way you said that while looking at the camera makes it hard to look away.", "That line with your tone was a little too smooth.", "You are being dangerously charming right now—the room is blushing."]
        case "Funny":
            variants = ["That pause had perfect comedic timing—I almost lost the plot.", "This story is turning into a full series. Where is the next episode?", "You sounded serious, but the whole room is already laughing."]
        case "Curious":
            variants = ["How did this situation begin in the first place?", "What made you choose that at the time?", "If you could replay it, which step would you change?"]
        default:
            return nil
        }

        let hash = text.unicodeScalars.reduce(UInt(chatHistory.count + 1)) { ($0 &* 31) &+ UInt($1.value) }
        return variants[Int(hash % UInt(variants.count))]
    }

    private func scheduleNextAIGift(initialDelay: Bool = false) {
        giftTimer?.invalidate()
        giftTimer = nil
        guard preferences.giftsEnabled else { return }
        let baseInterval = initialDelay ? Double.random(in: 20...34) : nextGiftInterval()
        let interval = isThermallyCritical ? baseInterval * 3 : isThermallyLimited ? baseInterval * 2.2 : baseInterval
        giftTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { timer in
            timer.invalidate()
            if isRecording && preferences.giftsEnabled && !isThermallyCritical {
                triggerAIGift()
            }
            scheduleNextAIGift()
        }
    }

    private func scheduleFirstLiveGift() {
        giftTimer?.invalidate()
        giftTimer = nil
        guard preferences.giftsEnabled else { return }
        let interval = isThermallyLimited ? Double.random(in: 12...18) : Double.random(in: 4.6...5.6)
        giftTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { timer in
            timer.invalidate()
            if isRecording && preferences.giftsEnabled && !isThermallyCritical {
                triggerAIGift()
            }
            scheduleNextAIGift()
        }
    }

    private func scheduleNextAutoHeart(initialDelay: Bool = false) {
        heartTimer?.invalidate()
        let interval: Double
        if isThermallyCritical {
            interval = Double.random(in: 20...30)
        } else if isThermallyLimited {
            interval = Double.random(in: 10...18)
        } else if preferences.isPremiumMember {
            interval = initialDelay ? Double.random(in: 1.6...3.2) : Double.random(in: 2.8...6.0)
        } else {
            interval = initialDelay ? Double.random(in: 2.0...5.0) : Double.random(in: 4.0...9.0)
        }
        heartTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { timer in
            timer.invalidate()
            if isRecording && preferences.heartsEnabled && !isThermallyCritical {
                sendHeart()
                if !isThermallyLimited && Bool.random() {
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
        if preferences.isPremiumMember {
            return Double.random(in: 6.5...13.0)
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
        let freeSlowdownMultiplier: Double
        if shouldApplyLowCoinAudienceDecay && streamTime >= lowCoinAudienceDecayStart {
            let slowdownProgress = min(1.0, Double(streamTime - lowCoinAudienceDecayStart) / Double(lowCoinAudienceDecayDuration))
            freeSlowdownMultiplier = 1.55 + slowdownProgress * 1.75
        } else {
            freeSlowdownMultiplier = 1
        }
        return Double.random(in: baseInterval) * intensityMultiplier * freeSlowdownMultiplier
    }

    private func triggerAIGift() {
        guard !isThermallyCritical else { return }
        let selectedAssets = selectedGiftIndexes.compactMap { giftAssets[safe: $0] }
        let giftPool = (selectedAssets.isEmpty ? giftAssets : selectedAssets).filter { $0.resourceURL != nil }
        let asset = giftPool.randomElement() ?? giftAssets.first
        guard let asset, asset.resourceURL != nil else { return }
        let sender = giftSenders.randomElement() ?? "Emma"
        let gift = ActiveGiftEffect(asset: asset, senderName: sender)
        totalGifts += 1

        withAnimation(.spring(response: 0.35, dampingFraction: 0.78)) {
            if activeGifts.count >= 2 {
                activeGifts.removeFirst(activeGifts.count - 1)
            }
            activeGifts.append(gift)
            popularity = min(popularityCeiling, popularity + Int.random(in: 180...980))
            if preferences.commentsEnabled {
                let comment = ChatComment(name: sender, avatar: "🎁", text: "sent you a little boost")
                rememberChatComment(comment)
                comments.append(comment)
                trimLiveComments(maxRobotComments: 3)
                expireComment(comment.id, after: 3.2)
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) {
            withAnimation(.easeOut(duration: 0.25)) {
                activeGifts.removeAll { $0.id == gift.id }
            }
        }
    }

    private func sendHeart() {
        guard isRecording, !isThermallyCritical else { return }
        totalLikes += 1
        let heart = FloatingHeart(emoji: heartEmojis.randomElement() ?? "❤️", xOffset: CGFloat.random(in: -30...30))
        if hearts.count >= 6 {
            hearts.removeFirst(hearts.count - 5)
        }
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

private struct LiveChatHistoryPanel: View {
    let comments: [ChatComment]
    let listener: Listener
    let avatarURLs: [String: String]
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Chat History")
                        .font(.system(size: 18, weight: .black))
                        .foregroundStyle(.white)
                    Text("Saved AI replies · swipe up for older messages")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.white.opacity(0.48))
                }
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .black))
                        .foregroundStyle(.white.opacity(0.82))
                        .frame(width: 40, height: 40)
                        .background(.white.opacity(0.10), in: Circle())
                        .frame(width: 56, height: 56)
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
            }
            .padding(16)

            Divider().overlay(.white.opacity(0.10))

            ScrollViewReader { proxy in
                ScrollView(showsIndicators: true) {
                    if comments.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "bubble.left.and.exclamationmark.bubble.right")
                                .font(.system(size: 28))
                                .foregroundStyle(Color.brandPurple)
                            Text("No saved AI replies yet")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(.white.opacity(0.82))
                            Text("AI replies from this and previous live sessions will appear here.")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.white.opacity(0.48))
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 54)
                        .padding(.horizontal, 24)
                    } else {
                        LazyVStack(spacing: 10) {
                            ForEach(comments) { comment in
                                historyRow(comment)
                                    .id(comment.id)
                            }
                        }
                        .padding(14)
                    }
                }
                .onAppear {
                    if let latestId = comments.last?.id {
                        DispatchQueue.main.async {
                            proxy.scrollTo(latestId, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .background(.black.opacity(0.90), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(.white.opacity(0.16)))
        .shadow(color: .black.opacity(0.46), radius: 28, y: 12)
    }

    private func historyRow(_ comment: ChatComment) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Group {
                if let imageURL = avatarURLs[comment.name] ?? (comment.kind == .deepAnswer ? listener.imageURL : nil) {
                    RemoteImage(urlString: imageURL)
                        .frame(width: 38, height: 38)
                        .clipShape(Circle())
                } else {
                    Text(comment.avatar)
                        .font(.system(size: 18))
                        .frame(width: 38, height: 38)
                        .background(.white.opacity(0.09), in: Circle())
                }
            }

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(comment.name)
                        .font(.system(size: 13, weight: .black))
                        .foregroundStyle(.white)
                    if comment.kind == .deepAnswer {
                        Text("AI REPLY")
                            .font(.system(size: 9, weight: .black))
                            .foregroundStyle(Color.brandPurple)
                    } else if comment.kind == .userSpeech {
                        Text("YOU")
                            .font(.system(size: 9, weight: .black))
                            .foregroundStyle(.cyan)
                    }
                    Spacer()
                    Text(comment.createdAt.formatted(date: .omitted, time: .shortened))
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.white.opacity(0.34))
                }
                Text(comment.text)
                    .font(.system(size: 13, weight: comment.kind == .deepAnswer ? .semibold : .regular))
                    .foregroundStyle(.white.opacity(comment.kind == .barrage ? 0.68 : 0.94))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .background(
                comment.kind == .deepAnswer
                    ? Color.brandPurple.opacity(0.18)
                    : (comment.kind == .userSpeech ? Color.cyan.opacity(0.13) : .white.opacity(0.06)),
                in: RoundedRectangle(cornerRadius: 16)
            )
        }
    }
}

private struct ChatBubble: View {
    let comment: ChatComment
    @State private var isExpanded = false

    private var isAIReply: Bool {
        comment.kind == .deepAnswer
    }

    private var isExpandable: Bool {
        guard comment.kind == .deepAnswer else { return false }
        let usesCJK = comment.text.unicodeScalars.contains { (0x3400...0x9FFF).contains(Int($0.value)) }
        return comment.text.count > (usesCJK ? 34 : 78)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Text(comment.name)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white.opacity(0.96))
                    .shadow(color: .black.opacity(0.50), radius: 2, y: 1)
                Circle()
                    .fill(isAIReply ? Color.brandPurple : .white.opacity(0.42))
                    .frame(width: isAIReply ? 6 : 4, height: isAIReply ? 6 : 4)
                if isAIReply {
                    Text("AI reply")
                        .font(.system(size: 10, weight: .black))
                        .foregroundStyle(Color(red: 0.86, green: 0.82, blue: 1))
                        .shadow(color: .black.opacity(0.38), radius: 2, y: 1)
                }
            }

            Text(comment.text)
                .font(.system(size: isAIReply ? 14 : 13, weight: isAIReply ? .semibold : .regular))
                .foregroundStyle(.white.opacity(isAIReply ? 0.98 : 0.84))
                .lineSpacing(isAIReply ? 3 : 2)
                .lineLimit(isExpanded ? nil : 2)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: isExpanded)
                .shadow(color: .black.opacity(isAIReply ? 0.72 : 0.36), radius: isAIReply ? 3 : 1.5, y: 1)

            if isExpandable {
                HStack(spacing: 5) {
                    Spacer()
                    Text(isExpanded ? "Show less" : "Tap to expand")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color.brandPurple.opacity(0.90))
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Color.brandPurple.opacity(0.82))
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            if isAIReply {
                RoundedRectangle(cornerRadius: 17, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .environment(\.colorScheme, .dark)
                    .overlay {
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.055),
                                Color.brandPurple.opacity(0.075),
                                Color.black.opacity(0.035)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                    }
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(.black.opacity(0.50))
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: isAIReply ? 17 : 16, style: .continuous)
                .stroke(
                    isAIReply
                        ? LinearGradient(
                            colors: [.white.opacity(0.24), Color.brandPurple.opacity(0.34), .white.opacity(0.08)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                        : LinearGradient(colors: [.white.opacity(0.10)], startPoint: .top, endPoint: .bottom),
                    lineWidth: isAIReply ? 0.9 : 0.8
                )
        }
        .shadow(color: .black.opacity(isAIReply ? 0.16 : 0.24), radius: isAIReply ? 10 : 5, y: 4)
        .contentShape(Rectangle())
        .onTapGesture {
            guard isExpandable else { return }
            withAnimation(.easeInOut(duration: 0.22)) {
                isExpanded.toggle()
            }
        }
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
    let onSendPrompt: (String) -> Void
    let onBuyViewers: (Int, Int) -> Void
    let onClose: () -> Void
    @State private var isExpanded = false
    @FocusState private var isPromptFocused: Bool

    private let toneTopicsData = ["General", "Agree", "Disagree", "Compliment", "Beauty", "Fashion", "Health", "Lifestyle", "Travel"]
    private let roleModes = ["Supportive", "Playful", "Honest"]
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
        VStack(spacing: 11) {
            if isPromptFocused {
                HStack {
                    Text("Message \(listener.name)")
                        .font(.system(size: 14, weight: .black))
                        .foregroundStyle(.white.opacity(0.78))
                    Spacer()
                    Button {
                        isPromptFocused = false
                    } label: {
                        Image(systemName: "keyboard.chevron.compact.down")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.white.opacity(0.72))
                            .frame(width: 36, height: 36)
                            .background(.white.opacity(0.10), in: Circle())
                    }
                    .buttonStyle(.plain)
                }
            } else {
                Capsule()
                    .fill(.white.opacity(0.34))
                    .frame(width: 42, height: 4)
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

                HStack {
                    Text(panelTitle)
                        .font(.system(size: 18, weight: .black))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(.white.opacity(0.76))
                            .frame(width: 40, height: 40)
                            .background(.white.opacity(0.14), in: Circle())
                            .frame(width: 56, height: 56)
                    }
                    .buttonStyle(.plain)
                    .contentShape(Rectangle())
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
                            .frame(height: 52)
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
                .scrollDismissesKeyboard(.never)
                .frame(height: contentHeight)
            }

            if selectedTool == .tone {
                promptBar
            }
        }
        .padding(isPromptFocused ? 12 : 16)
        .background {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(.ultraThinMaterial)
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(Color(red: 0.025, green: 0.030, blue: 0.055).opacity(0.64))
        }
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(.white.opacity(0.18), lineWidth: 1))
        .shadow(color: .black.opacity(0.28), radius: 22, y: 10)
        .animation(.spring(response: 0.28, dampingFraction: 0.88), value: isPromptFocused)
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
            return selectedTool == .tone ? 410 : 430
        }

        switch selectedTool {
        case .tone:
            return 300
        case .vibe:
            return 270
        case .viewers:
            return 190
        case .filters:
            return 250
        case .gifts:
            return 330
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
                    .textInputAutocapitalization(.sentences)
                    .disableAutocorrection(true)
                    .focused($isPromptFocused)
                    .submitLabel(.send)
                    .onSubmit(sendPrompt)
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(.white.opacity(0.10), in: Capsule())
                    .overlay(Capsule().stroke(.white.opacity(0.14)))
                    .contentShape(Capsule())

                Button {
                    sendPrompt()
                } label: {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 52, height: 52)
                        .background(Color.brandPurple, in: Circle())
                }
                .buttonStyle(.plain)
                .contentShape(Circle())
                .disabled(!hasPromptText)
                .opacity(hasPromptText ? 1 : 0.42)
            }
        }
    }

    private func sendPrompt() {
        let prompt = quickPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        quickPrompt = ""
        isPromptFocused = false
        onSendPrompt(prompt)
    }

    private var hasPromptText: Bool {
        !quickPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @ViewBuilder
    private var toolContent: some View {
        switch selectedTool {
        case .tone:
            VStack(alignment: .leading, spacing: 16) {
                Text("AI FRIEND STYLE")
                    .font(.system(size: 12, weight: .black))
                    .foregroundStyle(.white.opacity(0.48))
                HStack(spacing: 8) {
                    ForEach(roleModes, id: \.self) { mode in
                        Button {
                            aiRoleMode = mode
                        } label: {
                            Text(mode)
                                .font(.system(size: 12, weight: .black))
                                .foregroundStyle(aiRoleMode == mode ? .white : .white.opacity(0.48))
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                                .background(aiRoleMode == mode ? Color.brandPurple.opacity(0.58) : .white.opacity(0.08), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                LivePanelSlider(title: "Reply Depth", value: $aiReplyDepth, icon: "text.bubble")
                Text("BARRAGE TOPICS")
                    .font(.system(size: 12, weight: .black))
                    .foregroundStyle(.white.opacity(0.48))
                FlowTags(items: toneTopicsData, selected: toneTopics) { topic in
                    toggle(topic, in: &toneTopics, allowsEmpty: false)
                }
            }
        case .vibe:
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(vibeMoods.contains("Haters") ? "HATERS MODE" : "AUDIENCE MOOD")
                    Spacer()
                    Text(vibeMoods.contains("Haters")
                         ? "Skeptical comments active"
                         : "\(vibeMoods.count) active · choose one or more")
                }
                .font(.system(size: 12, weight: .black))
                .foregroundStyle(.white.opacity(0.48))

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
                    ForEach(vibeData, id: \.0) { item in
                        let active = vibeMoods.contains(item.0)
                        Button {
                            if item.0 == "Haters" {
                                vibeMoods = active ? ["Hype"] : ["Haters"]
                            } else {
                                vibeMoods.removeAll { $0 == "Haters" }
                                toggle(item.0, in: &vibeMoods, allowsEmpty: false)
                            }
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
                LivePanelSlider(title: "Natural Beauty", value: $beautyFilter, icon: "wand.and.stars")
                HStack {
                    Text(beautyFilter < 0.05 ? "OFF" : beautyFilter < 0.4 ? "NATURAL" : beautyFilter < 0.72 ? "SMOOTH" : "STRONG")
                    Spacer()
                    Text("Applied to preview & saved video")
                }
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.white.opacity(0.46))
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
                LivePanelSlider(title: "Gift Frequency", value: $giftIntensity, icon: "timer")
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
private enum LiveCameraCaptureState: Equatable {
    case idle
    case starting
    case running
    case failed(String)
}

private final class LiveCameraRecorder: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    @Published private(set) var sceneContext = ""
    @Published private(set) var captureState: LiveCameraCaptureState = .idle
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.squadlive.beauty-camera", qos: .userInitiated)
    private let captureQueue = DispatchQueue(label: "com.squadlive.beauty-frames", qos: .userInteractive)
    private let visionQueue = DispatchQueue(label: "com.squadlive.scene-analysis", qos: .utility)
    private let videoOutput = AVCaptureVideoDataOutput()
    private let audioOutput = AVCaptureAudioDataOutput()
    private let imageContext = CIContext()
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private let noiseReductionFilter = CIFilter(name: "CINoiseReduction")
    private let colorControlsFilter = CIFilter(name: "CIColorControls")
    private let sharpenFilter = CIFilter(name: "CISharpenLuminance")
    private var videoDevice: AVCaptureDevice?
    private weak var previewView: BeautyCameraPreviewView?
    private var assetWriter: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var pixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var outputBufferPool: CVPixelBufferPool?
    private var outputDimensions: CMVideoDimensions?
    private var temporaryOutputBuffer: CVPixelBuffer?
    private var outputURL: URL?
    private var beautyIntensity = 0.36
    private var thermalBeautyMultiplier = 1.0
    private var targetFrameRate: Int32 = 24
    private var isConfigured = false
    private var wantsRecording = false
    private var recordingStartTime: CMTime?
    private var shouldDiscardRecording = false
    private var finishHandler: ((URL?) -> Void)?
    private var speechAudioHandler: ((CMSampleBuffer) -> Void)?
    private var lastSceneAnalysisTime: TimeInterval = 0
    private var isSceneAnalysisInFlight = false
    private var previousBodyPoints: [VNHumanBodyPoseObservation.JointName: CGPoint] = [:]
    private var allowsSceneAnalysis = true
    private var sceneAnalysisPausedUntil: TimeInterval = 0
    private let screenRecorder = RPScreenRecorder.shared()
    private var isStartingScreenRecording = false
    private var didStartScreenRecording = false
    private var shouldCancelScreenRecording = false
    private var pendingScreenRecordingStop: ((URL?) -> Void)?
    private var screenRecordingRetryWorkItem: DispatchWorkItem?

    func attachPreview(_ view: BeautyCameraPreviewView) {
        captureQueue.async { [weak self, weak view] in
            guard let self, let view else { return }
            self.previewView = view
        }
    }

    func updateBeautyIntensity(_ intensity: Double) {
        captureQueue.async { [weak self] in
            self?.beautyIntensity = min(max(intensity, 0), 1)
        }
    }

    func pauseSceneAnalysis(for duration: TimeInterval) {
        captureQueue.async { [weak self] in
            guard let self else { return }
            sceneAnalysisPausedUntil = max(
                sceneAnalysisPausedUntil,
                Date().timeIntervalSinceReferenceDate + max(0, duration)
            )
        }
    }

    func setSpeechAudioHandler(_ handler: ((CMSampleBuffer) -> Void)?) {
        captureQueue.async { [weak self] in
            self?.speechAudioHandler = handler
        }
    }

    func updateThermalState(_ state: ProcessInfo.ThermalState) {
        let targetFPS: Int32
        let beautyMultiplier: Double
        switch state {
        case .serious:
            targetFPS = 20
            beautyMultiplier = 0.65
        case .critical:
            targetFPS = 15
            beautyMultiplier = 0
        default:
            targetFPS = 24
            beautyMultiplier = 1
        }
        captureQueue.async { [weak self] in
            self?.thermalBeautyMultiplier = beautyMultiplier
            self?.allowsSceneAnalysis = state != .serious && state != .critical
            self?.targetFrameRate = targetFPS
        }
        sessionQueue.async { [weak self] in
            self?.setFrameRate(targetFPS)
        }
    }

    func startCaptureAndRecording() {
        DispatchQueue.main.async { [weak self] in
            self?.captureState = .starting
        }
        activateAudioSession()
        screenRecordingRetryWorkItem?.cancel()
        screenRecordingRetryWorkItem = nil
        shouldCancelScreenRecording = false
        sessionQueue.async { [weak self] in
            guard let self else { return }
            guard self.configureSessionIfNeeded() else {
                self.publishCaptureFailure("Unable to configure the front camera.")
                return
            }
            self.captureQueue.sync {
                self.resetWriterState()
                self.lastSceneAnalysisTime = 0
                self.isSceneAnalysisInFlight = false
                self.shouldDiscardRecording = false
                // ReplayKit records the complete live composition. A second camera-only
                // encode was discarded at the end of every session and needlessly added heat.
                self.wantsRecording = false
                self.outputURL = FileManager.default.temporaryDirectory
                    .appendingPathComponent("squadlive-beauty-\(UUID().uuidString).mp4")
                if let outputURL = self.outputURL {
                    try? FileManager.default.removeItem(at: outputURL)
                }
                DispatchQueue.main.async { [weak self] in
                    self?.sceneContext = ""
                }
            }
            if !self.session.isRunning {
                self.session.startRunning()
            }
            guard self.session.isRunning else {
                self.publishCaptureFailure("The camera session could not start.")
                return
            }
            let workItem = DispatchWorkItem { [weak self] in
                self?.startScreenRecording(attempt: 0)
            }
            DispatchQueue.main.async {
                self.screenRecordingRetryWorkItem = workItem
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: workItem)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self, self.captureState == .starting else { return }
                self.publishCaptureFailure("The camera did not provide video frames. Please retry.")
            }
        }
    }

    private func publishCaptureFailure(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            self?.captureState = .failed(message)
        }
    }

    private func activateAudioSession() {
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(
                .playAndRecord,
                mode: .videoRecording,
                options: [.defaultToSpeaker, .allowBluetoothHFP, .mixWithOthers]
            )
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            return
        }
    }

    func stopRecording(completion: @escaping (URL?) -> Void) {
        var cameraRecordingURL: URL?
        var screenRecordingURL: URL?
        var remainingCompletions = 2

        let finishIfReady: () -> Void = {
            remainingCompletions -= 1
            guard remainingCompletions == 0 else { return }
            if let cameraRecordingURL {
                try? FileManager.default.removeItem(at: cameraRecordingURL)
            }
            completion(screenRecordingURL)
        }

        stopScreenRecording { url in
            screenRecordingURL = url
            finishIfReady()
        }

        stopCameraRecording { url in
            cameraRecordingURL = url
            finishIfReady()
        }
    }

    private func stopCameraRecording(completion: @escaping (URL?) -> Void) {
        sessionQueue.async { [weak self] in
            guard let self else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            if self.session.isRunning {
                self.session.stopRunning()
            }
            self.captureQueue.async {
                self.finishHandler = completion
                self.finishWriter()
            }
        }
    }

    func cancelRecording() {
        cancelScreenRecording()
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning {
                self.session.stopRunning()
            }
            self.captureQueue.async {
                self.shouldDiscardRecording = true
                self.wantsRecording = false
                self.finishHandler = nil
                self.assetWriter?.cancelWriting()
                if let outputURL = self.outputURL {
                    try? FileManager.default.removeItem(at: outputURL)
                }
                self.resetWriterState()
            }
        }
    }

    private func startScreenRecording(attempt: Int) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let recorder = self.screenRecorder
            guard !self.shouldCancelScreenRecording,
                  !recorder.isRecording,
                  !self.isStartingScreenRecording else { return }
            guard recorder.isAvailable else {
                self.scheduleScreenRecordingRetry(after: attempt)
                return
            }

            self.shouldCancelScreenRecording = false
            self.isStartingScreenRecording = true
            recorder.isMicrophoneEnabled = true
            recorder.startRecording { [weak self] error in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.isStartingScreenRecording = false
                    self.didStartScreenRecording = error == nil

                    if self.shouldCancelScreenRecording {
                        self.cancelScreenRecording()
                    } else if let pendingStop = self.pendingScreenRecordingStop {
                        self.pendingScreenRecordingStop = nil
                        self.stopScreenRecording(completion: pendingStop)
                    } else if error != nil {
                        self.scheduleScreenRecordingRetry(after: attempt)
                    } else {
                        self.screenRecordingRetryWorkItem?.cancel()
                        self.screenRecordingRetryWorkItem = nil
                    }
                }
            }
        }
    }

    private func scheduleScreenRecordingRetry(after attempt: Int) {
        guard !shouldCancelScreenRecording else { return }
        let retryDelays: [TimeInterval] = [0.8, 1.5, 3]
        guard attempt < retryDelays.count else { return }
        screenRecordingRetryWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.startScreenRecording(attempt: attempt + 1)
        }
        screenRecordingRetryWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + retryDelays[attempt], execute: workItem)
    }

    private func stopScreenRecording(completion: @escaping (URL?) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                completion(nil)
                return
            }
            self.screenRecordingRetryWorkItem?.cancel()
            self.screenRecordingRetryWorkItem = nil
            guard !self.isStartingScreenRecording else {
                self.pendingScreenRecordingStop = completion
                return
            }
            guard self.didStartScreenRecording, self.screenRecorder.isRecording else {
                self.didStartScreenRecording = false
                completion(nil)
                return
            }

            let outputURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("squadlive-composite-\(UUID().uuidString).mov")
            try? FileManager.default.removeItem(at: outputURL)
            self.screenRecorder.stopRecording(withOutput: outputURL) { [weak self] error in
                DispatchQueue.main.async {
                    self?.didStartScreenRecording = false
                    if error != nil {
                        try? FileManager.default.removeItem(at: outputURL)
                        completion(nil)
                    } else {
                        completion(outputURL)
                    }
                }
            }
        }
    }

    private func cancelScreenRecording() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.shouldCancelScreenRecording = true
            self.screenRecordingRetryWorkItem?.cancel()
            self.screenRecordingRetryWorkItem = nil
            self.pendingScreenRecordingStop = nil
            guard !self.isStartingScreenRecording,
                  self.didStartScreenRecording,
                  self.screenRecorder.isRecording else {
                if !self.isStartingScreenRecording {
                    self.didStartScreenRecording = false
                }
                return
            }

            let outputURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("squadlive-discard-\(UUID().uuidString).mov")
            self.screenRecorder.stopRecording(withOutput: outputURL) { [weak self] _ in
                try? FileManager.default.removeItem(at: outputURL)
                DispatchQueue.main.async {
                    self?.didStartScreenRecording = false
                }
            }
        }
    }

    private func configureSessionIfNeeded() -> Bool {
        guard !isConfigured else { return true }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        // 720p keeps the live preview sharp while reducing sustained camera and filter load.
        session.sessionPreset = .hd1280x720

        guard let videoDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let videoDeviceInput = try? AVCaptureDeviceInput(device: videoDevice),
              session.canAddInput(videoDeviceInput) else { return false }
        session.addInput(videoDeviceInput)
        self.videoDevice = videoDevice
        do {
            try videoDevice.lockForConfiguration()
            defer { videoDevice.unlockForConfiguration() }
            if videoDevice.isFocusModeSupported(.continuousAutoFocus) {
                videoDevice.focusMode = .continuousAutoFocus
            }
            if videoDevice.isExposureModeSupported(.continuousAutoExposure) {
                videoDevice.exposureMode = .continuousAutoExposure
            }
            let preferredExposureBias = min(max(0.45, videoDevice.minExposureTargetBias), videoDevice.maxExposureTargetBias)
            videoDevice.setExposureTargetBias(preferredExposureBias)
            if videoDevice.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                videoDevice.whiteBalanceMode = .continuousAutoWhiteBalance
            }
            if videoDevice.isLowLightBoostSupported {
                videoDevice.automaticallyEnablesLowLightBoostWhenAvailable = true
            }
        } catch {}

        if let audioDevice = AVCaptureDevice.default(for: .audio),
           let audioDeviceInput = try? AVCaptureDeviceInput(device: audioDevice),
           session.canAddInput(audioDeviceInput) {
            session.addInput(audioDeviceInput)
        }

        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        videoOutput.setSampleBufferDelegate(self, queue: captureQueue)
        guard session.canAddOutput(videoOutput) else { return false }
        session.addOutput(videoOutput)

        audioOutput.setSampleBufferDelegate(self, queue: captureQueue)
        if session.canAddOutput(audioOutput) {
            session.addOutput(audioOutput)
        }

        if let connection = videoOutput.connection(with: .video) {
            if connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90
            }
            if connection.isVideoMirroringSupported {
                connection.isVideoMirrored = true
            }
        }
        setFrameRate(24)
        isConfigured = true
        return true
    }

    private func setFrameRate(_ framesPerSecond: Int32) {
        guard let videoDevice,
              videoDevice.activeFormat.videoSupportedFrameRateRanges.contains(where: {
                  $0.minFrameRate <= Double(framesPerSecond) && $0.maxFrameRate >= Double(framesPerSecond)
              }) else { return }
        do {
            try videoDevice.lockForConfiguration()
            let frameDuration = CMTime(value: 1, timescale: framesPerSecond)
            videoDevice.activeVideoMinFrameDuration = frameDuration
            videoDevice.activeVideoMaxFrameDuration = frameDuration
            videoDevice.unlockForConfiguration()
        } catch {
            return
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output === videoOutput {
            processVideoSample(sampleBuffer)
        } else if output === audioOutput {
            appendAudioSample(sampleBuffer)
        }
    }

    private func processVideoSample(_ sampleBuffer: CMSampleBuffer) {
        if captureState != .running {
            DispatchQueue.main.async { [weak self] in
                guard self?.captureState == .starting else { return }
                self?.captureState = .running
            }
        }
        guard let sourceBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let width = CVPixelBufferGetWidth(sourceBuffer)
        let height = CVPixelBufferGetHeight(sourceBuffer)
        guard prepareOutputPool(width: width, height: height), let outputBufferPool else { return }

        temporaryOutputBuffer = nil
        guard CVPixelBufferPoolCreatePixelBuffer(nil, outputBufferPool, &temporaryOutputBuffer) == kCVReturnSuccess,
              let outputBuffer = temporaryOutputBuffer else { return }

        let sourceImage = CIImage(cvPixelBuffer: sourceBuffer)
        analyzeSceneIfNeeded(sourceImage)
        let filteredImage = beautyImage(from: sourceImage).cropped(to: sourceImage.extent)
        imageContext.render(filteredImage, to: outputBuffer, bounds: sourceImage.extent, colorSpace: colorSpace)

        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        previewView?.display(pixelBuffer: outputBuffer, presentationTime: presentationTime)

        guard wantsRecording,
              prepareWriterIfNeeded(width: width, height: height, startTime: presentationTime),
              assetWriter?.status == .writing,
              let videoInput,
              videoInput.isReadyForMoreMediaData else { return }
        pixelBufferAdaptor?.append(outputBuffer, withPresentationTime: presentationTime)
    }

    private func analyzeSceneIfNeeded(_ sourceImage: CIImage) {
        let now = Date().timeIntervalSinceReferenceDate
        guard allowsSceneAnalysis,
              !isSceneAnalysisInFlight,
              now >= sceneAnalysisPausedUntil,
              now - lastSceneAnalysisTime >= 4 else { return }

        let longestSide = max(sourceImage.extent.width, sourceImage.extent.height)
        guard longestSide > 0 else { return }
        let scale = min(1, 320 / longestSide)
        let scaledImage = sourceImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = imageContext.createCGImage(scaledImage, from: scaledImage.extent) else { return }

        lastSceneAnalysisTime = now
        isSceneAnalysisInFlight = true
        visionQueue.async { [weak self] in
            guard let self else { return }
            let classificationRequest = VNClassifyImageRequest()
            let textRequest = VNRecognizeTextRequest()
            let bodyPoseRequest = VNDetectHumanBodyPoseRequest()
            textRequest.recognitionLevel = .fast
            textRequest.usesLanguageCorrection = false
            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .leftMirrored, options: [:])
            try? handler.perform([classificationRequest, textRequest, bodyPoseRequest])
            let labels = (classificationRequest.results ?? [])
                .filter { $0.confidence >= 0.04 }
                .prefix(8)
                .map { observation in
                    let label = observation.identifier.replacingOccurrences(of: "_", with: " ")
                    return "\(label) \(Int(observation.confidence * 100))%"
                }
            let visibleText = (textRequest.results ?? [])
                .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .prefix(3)
            var details: [String] = []
            if !labels.isEmpty {
                details.append("likely objects or scene: \(labels.joined(separator: ", "))")
            }
            if !visibleText.isEmpty {
                details.append("visible text: \(visibleText.joined(separator: " / "))")
            }
            if let pose = bodyPoseRequest.results?.first,
               let points = try? pose.recognizedPoints(.all) {
                let reliablePoints = points.filter { $0.value.confidence >= 0.35 }
                var actionSignals: [String] = []
                if let leftWrist = reliablePoints[.leftWrist],
                   let leftShoulder = reliablePoints[.leftShoulder],
                   leftWrist.location.y > leftShoulder.location.y {
                    actionSignals.append("left hand raised")
                }
                if let rightWrist = reliablePoints[.rightWrist],
                   let rightShoulder = reliablePoints[.rightShoulder],
                   rightWrist.location.y > rightShoulder.location.y {
                    actionSignals.append("right hand raised")
                }

                let currentPoints = reliablePoints.mapValues(\.location)
                let sharedJoints = currentPoints.keys.filter { self.previousBodyPoints[$0] != nil }
                if sharedJoints.count >= 4 {
                    let averageMovement = sharedJoints.reduce(CGFloat.zero) { total, joint in
                        guard let previous = self.previousBodyPoints[joint], let current = currentPoints[joint] else { return total }
                        return total + hypot(current.x - previous.x, current.y - previous.y)
                    } / CGFloat(sharedJoints.count)
                    if averageMovement > 0.055 {
                        actionSignals.append("noticeable body movement or gesture")
                    }
                }
                self.previousBodyPoints = currentPoints
                if !actionSignals.isEmpty {
                    details.append("visible action: \(actionSignals.joined(separator: ", "))")
                } else if !currentPoints.isEmpty {
                    details.append("a person is visible and relatively still")
                }
            }
            let context = details.isEmpty
                ? "A recent live-camera frame was analyzed, but no object was identified confidently. Do not say you cannot see; ask for a closer view when needed."
                : "A recent live-camera frame was analyzed on device and its visual signals are being supplied to the AI; \(details.joined(separator: "; ")). React naturally to meaningful objects, text, gestures, and movement. Say 'it looks like' when uncertain, and never claim details that are not listed."
            DispatchQueue.main.async { [weak self] in
                self?.sceneContext = context
            }
            self.captureQueue.async { [weak self] in
                self?.isSceneAnalysisInFlight = false
            }
        }
    }

    private func beautyImage(from sourceImage: CIImage) -> CIImage {
        let intensity = beautyIntensity * thermalBeautyMultiplier
        guard intensity >= 0.01 else { return sourceImage }
        let smoothedImage: CIImage
        noiseReductionFilter?.setValue(sourceImage, forKey: kCIInputImageKey)
        noiseReductionFilter?.setValue(0.008 + intensity * 0.025, forKey: "inputNoiseLevel")
        noiseReductionFilter?.setValue(0.52 + intensity * 0.08, forKey: "inputSharpness")
        smoothedImage = noiseReductionFilter?.outputImage ?? sourceImage

        colorControlsFilter?.setValue(smoothedImage, forKey: kCIInputImageKey)
        colorControlsFilter?.setValue(1 + intensity * 0.035, forKey: kCIInputSaturationKey)
        colorControlsFilter?.setValue(0.022 + intensity * 0.032, forKey: kCIInputBrightnessKey)
        colorControlsFilter?.setValue(1 + intensity * 0.012, forKey: kCIInputContrastKey)

        let balancedImage = colorControlsFilter?.outputImage ?? sourceImage
        sharpenFilter?.setValue(balancedImage, forKey: kCIInputImageKey)
        sharpenFilter?.setValue(0.18 + intensity * 0.16, forKey: kCIInputSharpnessKey)
        return sharpenFilter?.outputImage ?? balancedImage
    }

    private func prepareOutputPool(width: Int, height: Int) -> Bool {
        if outputDimensions?.width == Int32(width), outputDimensions?.height == Int32(height), outputBufferPool != nil {
            return true
        }
        let poolAttributes = [kCVPixelBufferPoolMinimumBufferCountKey as String: 5]
        let pixelAttributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:]
        ]
        var pool: CVPixelBufferPool?
        let status = CVPixelBufferPoolCreate(nil, poolAttributes as CFDictionary, pixelAttributes as CFDictionary, &pool)
        outputBufferPool = pool
        outputDimensions = CMVideoDimensions(width: Int32(width), height: Int32(height))
        return status == kCVReturnSuccess && pool != nil
    }

    private func prepareWriterIfNeeded(width: Int, height: Int, startTime: CMTime) -> Bool {
        if assetWriter != nil { return true }
        guard let outputURL,
              let writer = try? AVAssetWriter(outputURL: outputURL, fileType: .mp4) else { return false }

        let pixels = width * height
        let targetBitRate = pixels >= 1_900_000 ? 6_000_000 : 4_000_000
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: targetBitRate,
                AVVideoExpectedSourceFrameRateKey: targetFrameRate,
                AVVideoMaxKeyFrameIntervalKey: targetFrameRate * 2,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
            ]
        ]
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(videoInput) else { return false }
        writer.add(videoInput)

        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 96_000
        ])
        audioInput.expectsMediaDataInRealTime = true
        if writer.canAdd(audioInput) {
            writer.add(audioInput)
            self.audioInput = audioInput
        }

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoInput, sourcePixelBufferAttributes: nil)
        guard writer.startWriting() else { return false }
        writer.startSession(atSourceTime: startTime)
        assetWriter = writer
        self.videoInput = videoInput
        pixelBufferAdaptor = adaptor
        recordingStartTime = startTime
        return true
    }

    private func appendAudioSample(_ sampleBuffer: CMSampleBuffer) {
        speechAudioHandler?(sampleBuffer)
        guard wantsRecording,
              let recordingStartTime,
              CMSampleBufferGetPresentationTimeStamp(sampleBuffer) >= recordingStartTime,
              assetWriter?.status == .writing,
              let audioInput,
              audioInput.isReadyForMoreMediaData else { return }
        audioInput.append(sampleBuffer)
    }

    private func finishWriter() {
        wantsRecording = false
        guard let writer = assetWriter, let outputURL else {
            finishRecording(with: nil)
            return
        }
        guard writer.status == .writing else {
            try? FileManager.default.removeItem(at: outputURL)
            finishRecording(with: nil)
            return
        }
        videoInput?.markAsFinished()
        audioInput?.markAsFinished()
        writer.finishWriting { [weak self] in
            guard let self else { return }
            self.captureQueue.async {
                let shouldKeep = !self.shouldDiscardRecording && writer.status == .completed
                if !shouldKeep {
                    try? FileManager.default.removeItem(at: outputURL)
                }
                self.finishRecording(with: shouldKeep ? outputURL : nil)
            }
        }
    }

    private func finishRecording(with url: URL?) {
        resetWriterState()
        let completion = finishHandler
        finishHandler = nil
        DispatchQueue.main.async {
            completion?(url)
        }
    }

    private func resetWriterState() {
        assetWriter = nil
        videoInput = nil
        audioInput = nil
        pixelBufferAdaptor = nil
        recordingStartTime = nil
        wantsRecording = false
        temporaryOutputBuffer = nil
        outputURL = nil
    }
}

private struct CameraPreview: UIViewRepresentable {
    @ObservedObject var recorder: LiveCameraRecorder
    let beautyIntensity: Double

    func makeUIView(context: Context) -> BeautyCameraPreviewView {
        let view = BeautyCameraPreviewView()
        recorder.attachPreview(view)
        return view
    }

    func updateUIView(_ uiView: BeautyCameraPreviewView, context: Context) {
        recorder.attachPreview(uiView)
        recorder.updateBeautyIntensity(beautyIntensity)
    }

    static func dismantleUIView(_ uiView: BeautyCameraPreviewView, coordinator: ()) {
        uiView.flush()
    }
}

private final class BeautyCameraPreviewView: UIView {
    private var formatDescription: CMVideoFormatDescription?
    private var formatDimensions: CMVideoDimensions?

    override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }

    private var displayLayer: AVSampleBufferDisplayLayer {
        layer as! AVSampleBufferDisplayLayer
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        displayLayer.videoGravity = .resizeAspectFill
        backgroundColor = .black
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        displayLayer.videoGravity = .resizeAspectFill
        backgroundColor = .black
    }

    func display(pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
        let dimensions = CMVideoDimensions(
            width: Int32(CVPixelBufferGetWidth(pixelBuffer)),
            height: Int32(CVPixelBufferGetHeight(pixelBuffer))
        )
        if formatDescription == nil || formatDimensions?.width != dimensions.width || formatDimensions?.height != dimensions.height {
            var newFormatDescription: CMVideoFormatDescription?
            guard CMVideoFormatDescriptionCreateForImageBuffer(
                allocator: kCFAllocatorDefault,
                imageBuffer: pixelBuffer,
                formatDescriptionOut: &newFormatDescription
            ) == noErr else { return }
            formatDescription = newFormatDescription
            formatDimensions = dimensions
        }
        guard let formatDescription else { return }

        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: presentationTime, decodeTimeStamp: .invalid)
        var sampleBuffer: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: formatDescription,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        ) == noErr, let sampleBuffer else { return }

        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let attachment = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(
                attachment,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.displayLayer.status == .failed {
                self.displayLayer.flush()
            }
            self.displayLayer.enqueue(sampleBuffer)
        }
    }

    func flush() {
        displayLayer.flushAndRemoveImage()
    }
}
#else
private final class LiveCameraRecorder: ObservableObject {
    @Published private(set) var sceneContext = ""
    func startCaptureAndRecording() {}
    func stopRecording(completion: @escaping (URL?) -> Void) { completion(nil) }
    func cancelRecording() {}
    func updateBeautyIntensity(_ intensity: Double) {}
    func updateThermalState(_ state: ProcessInfo.ThermalState) {}
    func pauseSceneAnalysis(for duration: TimeInterval) {}
    func setSpeechAudioHandler(_ handler: ((CMSampleBuffer) -> Void)?) {}
}

private struct CameraPreview: View {
    let recorder: LiveCameraRecorder
    let beautyIntensity: Double

    var body: some View {
        LinearGradient(colors: [.brandPurple.opacity(0.36), .black.opacity(0.94), .black], startPoint: .top, endPoint: .bottom)
    }
}
#endif

private struct LiveReviewPrompt: View {
    let onPositiveFeedback: () -> Void
    let onNegativeFeedback: () -> Void

    var body: some View {
        GeometryReader { geometry in
            let compact = geometry.size.width < 390 || geometry.size.height < 720
            let modalWidth = min(geometry.size.width - (compact ? 28 : 44), 500)

            ZStack {
                Color.black.opacity(0.70)
                    .ignoresSafeArea()
                    .onTapGesture(perform: onNegativeFeedback)

                VStack(spacing: compact ? 16 : 22) {
                    HStack {
                        Spacer()
                        Button(action: onNegativeFeedback) {
                            Image(systemName: "xmark")
                                .font(.system(size: compact ? 17 : 20, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.72))
                                .frame(width: 42, height: 42)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .frame(height: 30)

                    reviewIcon(compact: compact)

                    VStack(spacing: compact ? 8 : 12) {
                        Text("Do you like SquadLive?")
                            .font(.system(size: compact ? 26 : 32, weight: .bold))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .minimumScaleFactor(0.82)

                        Text("If you enjoy using SquadLive, we'd love to hear from you. Your feedback helps us make every AI friend feel more alive.")
                            .font(.system(size: compact ? 13 : 15, weight: .medium))
                            .foregroundStyle(.white.opacity(0.68))
                            .multilineTextAlignment(.center)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) {
                            positiveButton(compact: compact)
                            negativeButton(compact: compact)
                        }

                        VStack(spacing: 10) {
                            positiveButton(compact: true)
                            negativeButton(compact: true)
                        }
                    }

                    Label("Your feedback helps us improve SquadLive", systemImage: "checkmark.shield.fill")
                        .font(.system(size: compact ? 11 : 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.52))
                        .labelStyle(.titleAndIcon)
                }
                .padding(.horizontal, compact ? 18 : 28)
                .padding(.top, compact ? 10 : 14)
                .padding(.bottom, compact ? 20 : 28)
                .frame(width: modalWidth)
                .background {
                    RoundedRectangle(cornerRadius: compact ? 25 : 30, style: .continuous)
                        .fill(.ultraThinMaterial)
                        .overlay {
                            LinearGradient(
                                colors: [.white.opacity(0.06), .black.opacity(0.44)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                            .clipShape(RoundedRectangle(cornerRadius: compact ? 25 : 30, style: .continuous))
                        }
                }
                .overlay {
                    RoundedRectangle(cornerRadius: compact ? 25 : 30, style: .continuous)
                        .stroke(LinearGradient(colors: [.brandPurple.opacity(0.65), .white.opacity(0.14)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1)
                }
                .shadow(color: .black.opacity(0.62), radius: 34, y: 18)
                .padding(.vertical, 18)
            }
        }
        .ignoresSafeArea()
    }

    private func reviewIcon(compact: Bool) -> some View {
        ZStack {
            Ellipse()
                .stroke(Color.brandPurple.opacity(0.24), lineWidth: 2)
                .frame(width: compact ? 150 : 190, height: compact ? 50 : 62)

            RoundedRectangle(cornerRadius: compact ? 20 : 25, style: .continuous)
                .fill(LinearGradient(colors: [.brandPurple, Color(red: 0.30, green: 0.08, blue: 0.72)], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: compact ? 78 : 96, height: compact ? 66 : 80)
                .rotationEffect(.degrees(-8))
                .overlay {
                    Image(systemName: "heart.fill")
                        .font(.system(size: compact ? 29 : 36, weight: .bold))
                        .foregroundStyle(LinearGradient(colors: [.white, .pink.opacity(0.88)], startPoint: .top, endPoint: .bottom))
                }
                .shadow(color: Color.brandPurple.opacity(0.60), radius: 18)

            Image(systemName: "sparkle")
                .foregroundStyle(Color.brandPurple)
                .offset(x: compact ? 68 : 86, y: -18)

            Image(systemName: "sparkle")
                .font(.system(size: 11))
                .foregroundStyle(Color.brandPurple.opacity(0.78))
                .offset(x: compact ? -67 : -86, y: 20)
        }
        .frame(height: compact ? 82 : 104)
    }

    private func positiveButton(compact: Bool) -> some View {
        Button(action: onPositiveFeedback) {
            VStack(spacing: compact ? 7 : 10) {
                Image(systemName: "hand.thumbsup.fill")
                    .font(.system(size: compact ? 25 : 31, weight: .semibold))
                Text("Yes, I Love It!")
                    .font(.system(size: compact ? 14 : 17, weight: .bold))
                    .minimumScaleFactor(0.78)
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: compact ? 82 : 106)
            .background(LinearGradient(colors: [Color(red: 0.64, green: 0.20, blue: 1), Color(red: 0.42, green: 0.08, blue: 0.94)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(.white.opacity(0.40), lineWidth: 1))
            .shadow(color: Color.brandPurple.opacity(0.50), radius: 14)
        }
        .buttonStyle(.plain)
    }

    private func negativeButton(compact: Bool) -> some View {
        Button(action: onNegativeFeedback) {
            VStack(spacing: compact ? 7 : 10) {
                Image(systemName: "face.dashed")
                    .font(.system(size: compact ? 25 : 31, weight: .medium))
                Text("No, Thanks")
                    .font(.system(size: compact ? 14 : 17, weight: .bold))
                    .minimumScaleFactor(0.78)
                    .lineLimit(1)
            }
            .foregroundStyle(.white.opacity(0.72))
            .frame(maxWidth: .infinity)
            .frame(height: compact ? 82 : 106)
            .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(.white.opacity(0.14), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

private struct PaywallBanner: View {
    let listener: Listener
    let onClose: () -> Void
    let onUpgrade: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: -18) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .black))
                    .foregroundStyle(.white.opacity(0.90))
                    .frame(width: 40, height: 40)
                    .background(.black.opacity(0.68), in: Circle())
                    .overlay(Circle().stroke(.white.opacity(0.28)))
                    .frame(width: 60, height: 60)
            }
            .buttonStyle(.plain)
            .contentShape(Rectangle())
            .padding(.trailing, 2)
            .zIndex(5)

            Button(action: onUpgrade) {
                HStack(spacing: 14) {
                    Image("VIPPrivilegeIcon")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 62, height: 62)
                        .shadow(color: Color.gold.opacity(0.38), radius: 10)
                        .accessibilityLabel("PRO privileges")

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Keep your AI room highly active with PRO")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.leading)
                        Text("Free AI replies and gifts gradually slow after 4 minutes. PRO keeps dynamic 1–3 friend replies and gift effects frequent.")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.white.opacity(0.68))
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
        }
    }
}

private struct RemoteImage: View {
    let urlString: String
    var placeholderText: String? = nil

    var body: some View {
        CachedRemoteImageView(url: displayURL, placeholderText: placeholderText)
        .clipped()
    }

    private var displayURL: URL? {
        if let bundledURL = bundledResourceURL(from: urlString) {
            return bundledURL
        }

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

private func bundledResourceURL(from resourceString: String) -> URL? {
    guard let components = URLComponents(string: resourceString),
          components.scheme == "bundle-resource" else {
        return nil
    }

    let resource = components.host ?? components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let extensionName = (resource as NSString).pathExtension
    let resourceName = (resource as NSString).deletingPathExtension
    guard !resourceName.isEmpty, !extensionName.isEmpty else { return nil }

    return Bundle.main.url(forResource: resourceName, withExtension: extensionName, subdirectory: "AudienceAvatars")
        ?? Bundle.main.url(forResource: resourceName, withExtension: extensionName)
}

#if os(iOS)
private struct CachedRemoteImageView: View {
    let url: URL?
    let placeholderText: String?
    @State private var image: UIImage?
    @State private var didFail = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if didFail {
                remoteImageFallback(placeholderText: placeholderText)
            } else {
                remoteImagePlaceholder(placeholderText: placeholderText)
            }
        }
        .task(id: url) {
            await load()
        }
    }

    @MainActor
    private func load() async {
        didFail = false
        image = nil
        guard let url else {
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
        let urls = Set(urlStrings.compactMap { urlString -> URL? in
            if let bundledURL = bundledResourceURL(from: urlString) {
                if image(for: bundledURL) == nil, let image = UIImage(contentsOfFile: bundledURL.path) {
                    set(image, for: bundledURL)
                }
                return nil
            }
            return URL(string: urlString)
        })
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
    let placeholderText: String?

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .scaledToFill()
            case .failure:
                remoteImageFallback(placeholderText: placeholderText)
            default:
                remoteImagePlaceholder(placeholderText: placeholderText)
            }
        }
    }
}
#endif

private func remoteImageFallback(placeholderText: String?) -> some View {
    ZStack {
        LinearGradient(colors: [.brandPurple.opacity(0.55), .brandOrange.opacity(0.45)], startPoint: .topLeading, endPoint: .bottomTrailing)
        if let placeholderText {
            Text(placeholderText)
                .font(.system(size: 38))
        } else {
            Image(systemName: "person.fill")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.white.opacity(0.72))
        }
    }
}

private func remoteImagePlaceholder(placeholderText: String?) -> some View {
    ZStack {
        LinearGradient(colors: [.brandPurple.opacity(0.34), .brandOrange.opacity(0.22)], startPoint: .topLeading, endPoint: .bottomTrailing)
        if let placeholderText {
            Text(placeholderText)
                .font(.system(size: 38))
        } else {
            Image(systemName: "person.fill")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.white.opacity(0.62))
        }
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

    static func dismantleUIView(_ uiView: LoopingVideoUIView, coordinator: Void) {
        uiView.stop()
    }
}

private final class LoopingVideoUIView: UIView {
    private let player = AVQueuePlayer()
    private let playerLayer = AVPlayerLayer()
    private var currentURL: URL?
    private var playerLooper: AVPlayerLooper?
    private var lifecycleObservers: [NSObjectProtocol] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        playerLayer.videoGravity = .resizeAspectFill
        layer.addSublayer(playerLayer)
        playerLayer.player = player
        player.isMuted = true
        player.actionAtItemEnd = .none
        player.automaticallyWaitsToMinimizeStalling = false

        lifecycleObservers = [
            NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.resume()
            },
            NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.player.pause()
            }
        ]
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        playerLayer.frame = bounds
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            player.pause()
        } else {
            resume()
        }
    }

    func configure(url: URL) {
        guard currentURL != url else {
            resume()
            return
        }
        currentURL = url
        player.pause()
        player.removeAllItems()
        let item = AVPlayerItem(url: url)
        item.preferredForwardBufferDuration = 1
        playerLooper = AVPlayerLooper(player: player, templateItem: item)
        resume()
    }

    func stop() {
        player.pause()
        playerLooper?.disableLooping()
        playerLooper = nil
        player.removeAllItems()
        currentURL = nil
    }

    private func resume() {
        guard window != nil, currentURL != nil else { return }
        player.playImmediately(atRate: 1)
    }

    deinit {
        lifecycleObservers.forEach(NotificationCenter.default.removeObserver)
        stop()
    }
}
#endif

private struct PremiumCheckoutView: View {
    @ObservedObject var store: StorePurchaseManager
    let onClose: () -> Void
    let onSubscribe: () -> Void
    @State private var restoreMessage: String?
    @State private var selectedPlan = "weekly"

    private let benefits = [
        ("person.2.fill", "200K+ live room activity"),
        ("bubble.left.and.bubble.right", "High-frequency dynamic 1–3 friend replies"),
        ("timer", "No AI reply slowdown after 4 minutes"),
        ("sparkles", "No gift slowdown after 4 minutes"),
        ("person.3.fill", "More frequent multi-friend moments"),
        ("rectangle.stack.badge.plus", "No recurring upgrade reminders while live")
    ]

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ZStack {
                LoopingVideoBackground(resourceName: "PremiumFriendsLoop", resourceExtension: "m4v")
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
                    Group {
                        if !store.didLoadEntitlements {
                            membershipLoadingContent
                        } else if store.isPremium {
                            activeMembershipContent
                        } else {
                            purchaseContent
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                }
            }
        }
    }

    private var membershipLoadingContent: some View {
        VStack(spacing: 18) {
            ProgressView()
                .tint(.white)
                .scaleEffect(1.2)
            Text("Checking your membership...")
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(.white.opacity(0.76))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 90)
    }

    private var activeMembershipContent: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 68, weight: .bold))
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, Color.green)
                .shadow(color: Color.green.opacity(0.42), radius: 24)

            VStack(spacing: 6) {
                Text("SquadLive PRO Active")
                    .font(.system(size: 30, weight: .black))
                    .foregroundStyle(.white)
                Text("Your membership benefits are active on this Apple ID.")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.62))
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 0) {
                membershipDetailRow(title: "Plan", value: activePlanName)
                Divider().overlay(.white.opacity(0.10))
                membershipDetailRow(title: "Status", value: store.subscriptionStatusText, valueColor: membershipStatusColor)
                if let purchaseDate = store.subscriptionPurchaseDate {
                    Divider().overlay(.white.opacity(0.10))
                    membershipDetailRow(title: "Started", value: formatted(date: purchaseDate))
                }
                Divider().overlay(.white.opacity(0.10))
                membershipDetailRow(title: membershipDateTitle, value: expirationDescription)
            }
            .background(.black.opacity(0.38), in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(.white.opacity(0.13)))

            VStack(alignment: .leading, spacing: 14) {
                ForEach(benefits, id: \.1) { benefit in
                    HStack(spacing: 14) {
                        Image(systemName: benefit.0)
                            .font(.system(size: 14, weight: .bold))
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

            Button(action: onClose) {
                Text("Done")
                    .font(.system(size: 18, weight: .black))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .frame(height: 64)
            .background(Color.brandPurple, in: RoundedRectangle(cornerRadius: 18))
            .contentShape(RoundedRectangle(cornerRadius: 18))

#if os(iOS)
            Button(action: openManageSubscriptions) {
                Label("Manage Subscription", systemImage: "gearshape.fill")
                    .font(.system(size: 15, weight: .black))
                    .foregroundStyle(.white.opacity(0.82))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .background(.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
            .contentShape(RoundedRectangle(cornerRadius: 16))
#endif

            HStack(spacing: 18) {
                Button("Refresh Membership") {
                    Task {
                        _ = await store.restorePurchases()
                        restoreMessage = store.statusMessage
                    }
                }
                Link("Privacy Policy", destination: SquadLiveLegalLinks.privacy)
                Link("Terms of Use", destination: SquadLiveLegalLinks.terms)
            }
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(.white.opacity(0.48))

            if let restoreMessage {
                Text(restoreMessage)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white.opacity(0.72))
            }
        }
    }

    private var purchaseContent: some View {
        VStack(spacing: 18) {
            Text("SquadLive PRO")
                .font(.system(size: 34, weight: .black))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)

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

            VStack(spacing: 12) {
                SubscriptionPlanCard(
                    title: "Weekly Plan",
                    price: store.product(for: StoreProductID.weekly)?.displayPrice ?? "US$9.99",
                    detail: "per week",
                    badge: nil,
                    isSelected: selectedPlan == "weekly"
                ) {
                    selectedPlan = "weekly"
                }

                SubscriptionPlanCard(
                    title: "Annual Plan",
                    price: store.product(for: StoreProductID.annual)?.displayPrice ?? "US$59.99",
                    detail: "per year",
                    badge: "Best Value",
                    isSelected: selectedPlan == "yearly"
                ) {
                    selectedPlan = "yearly"
                }
            }

            if store.product(for: selectedSubscriptionProductID)?.subscription?.introductoryOffer?.paymentMode == .freeTrial {
                Label("3-day free trial for eligible new subscribers", systemImage: "checkmark.circle.fill")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white.opacity(0.78))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Color.green, .white.opacity(0.78))
            }

            Button {
                Task {
                    if await store.purchase(productID: selectedSubscriptionProductID) {
                        onSubscribe()
                    } else {
                        restoreMessage = store.statusMessage
                    }
                }
            } label: {
                Text(store.purchasingProductID == nil ? "Continue" : "Connecting to App Store...")
                    .font(.system(size: 19, weight: .black))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: 70)
                    .background(LinearGradient(colors: [Color(red: 0.34, green: 0.52, blue: 0.94), Color.brandPurpleDark], startPoint: .leading, endPoint: .trailing), in: RoundedRectangle(cornerRadius: 18))
                    .shadow(color: Color.brandPurple.opacity(0.32), radius: 24)
            }
            .disabled(store.purchasingProductID != nil)

            if let restoreMessage {
                Text(restoreMessage)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white.opacity(0.72))
            }

            HStack(spacing: 18) {
                Button("Restore Purchase") {
                    Task {
                    if await store.restorePurchases() {
                        onSubscribe()
                    }
                    restoreMessage = store.statusMessage
                    }
                }
                Link("Privacy Policy", destination: SquadLiveLegalLinks.privacy)
                Link("Terms of Use", destination: SquadLiveLegalLinks.terms)
            }
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(.white.opacity(0.42))
        }
    }

    private func membershipDetailRow(title: String, value: String, valueColor: Color = .white) -> some View {
        HStack(spacing: 16) {
            Text(title)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(.white.opacity(0.50))
            Spacer()
            Text(value)
                .font(.system(size: 14, weight: .black))
                .foregroundStyle(valueColor)
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 54)
    }

    private var activePlanName: String {
        switch store.activeSubscriptionProductID {
        case StoreProductID.weekly: "Weekly Plan"
        case StoreProductID.annual: "Annual Plan"
        default: "SquadLive PRO"
        }
    }

    private var selectedSubscriptionProductID: String {
        selectedPlan == "weekly" ? StoreProductID.weekly : StoreProductID.annual
    }

    private var membershipStatusColor: Color {
        store.subscriptionStatusText == "Active" ? .green : Color.gold
    }

    private var membershipDateTitle: String {
        if store.subscriptionGracePeriodExpirationDate != nil {
            return "Grace Period Until"
        }
        if store.subscriptionWillAutoRenew == true {
            return "Renews On"
        }
        if store.subscriptionWillAutoRenew == false {
            return "Expires On"
        }
        return "Valid Until"
    }

    private var expirationDescription: String {
        guard let expirationDate = store.subscriptionGracePeriodExpirationDate ?? store.subscriptionExpirationDate else {
            return "Managed by the App Store"
        }
        return formatted(date: expirationDate)
    }

#if os(iOS)
    private func openManageSubscriptions() {
        Task {
            guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }) else {
                restoreMessage = "Unable to open subscription management right now."
                return
            }
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                _ = await store.restorePurchases()
                restoreMessage = store.statusMessage
            } catch {
                restoreMessage = "Unable to open subscription management right now."
            }
        }
    }
#endif

    private func formatted(date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
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
