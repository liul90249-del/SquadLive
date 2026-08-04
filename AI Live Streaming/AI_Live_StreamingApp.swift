//
//  SquadLiveApp.swift
//  SquadLive
//
//  Created by liu on 2026/7/14.
//

import SwiftUI
#if os(iOS)
import FirebaseCore
import StoreKit
import UIKit
#endif

#if os(iOS)
private enum SquadLiveAppShortcut {
    static let reviewType = "com.liuzhigang.squadlive.rate"
    static let feedbackType = "com.liuzhigang.squadlive.feedback"
    private static let deviceIDKey = "squadlive.device-id"
    private static let supportEmail = "1655896527@qq.com"
    private static let backendURL = URL(string: "https://squadlive.onrender.com/v1/wallet/balance")!

    static func install() {
        UIApplication.shared.shortcutItems = [
            UIApplicationShortcutItem(
                type: reviewType,
                localizedTitle: "Rate SquadLive",
                localizedSubtitle: "Share your feedback",
                icon: UIApplicationShortcutIcon(systemImageName: "star.fill")
            ),
            UIApplicationShortcutItem(
                type: feedbackType,
                localizedTitle: "Send Feedback",
                localizedSubtitle: "Email SquadLive support",
                icon: UIApplicationShortcutIcon(systemImageName: "envelope.fill")
            )
        ]
    }

    static func handle(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
        switch shortcutItem.type {
        case reviewType:
            requestReviewWhenReady()
            return true
        case feedbackType:
            openFeedbackEmail()
            return true
        default:
            return false
        }
    }

    private static func openFeedbackEmail() {
        let deviceID = feedbackDeviceID()
        Task {
            let backendUserID = await fetchBackendUserID(deviceID: deviceID)
            await MainActor.run {
                openMailWhenReady(deviceID: deviceID, backendUserID: backendUserID)
            }
        }
    }

    private static func feedbackDeviceID() -> String {
        if let saved = UserDefaults.standard.string(forKey: deviceIDKey), !saved.isEmpty {
            return saved
        }
        let generated = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        UserDefaults.standard.set(generated, forKey: deviceIDKey)
        return generated
    }

    private static func fetchBackendUserID(deviceID: String) async -> String? {
        var request = URLRequest(url: backendURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 12
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceId": deviceID])
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let user = payload["user"] as? [String: Any] else {
            return nil
        }
        return user["id"] as? String
    }

    @MainActor
    private static func openMailWhenReady(deviceID: String, backendUserID: String?, attempt: Int = 0) {
        let hasActiveScene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .contains { $0.activationState == .foregroundActive }
        guard hasActiveScene else {
            guard attempt < 12 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                openMailWhenReady(deviceID: deviceID, backendUserID: backendUserID, attempt: attempt + 1)
            }
            return
        }

        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
        let userID = backendUserID ?? "Pending server lookup"
        let subject = "SquadLive Feedback [\(userID)]"
        let body = """
        Please describe your feedback or issue here:


        --- SquadLive Support Information ---
        Backend User ID: \(userID)
        User Lookup ID: \(deviceID)
        App Version: \(appVersion) (\(build))
        iOS Version: \(UIDevice.current.systemVersion)
        Device: \(UIDevice.current.model)
        Please keep the IDs above so support can locate your account.
        """
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = supportEmail
        components.queryItems = [
            URLQueryItem(name: "subject", value: subject),
            URLQueryItem(name: "body", value: body)
        ]
        guard let url = components.url else { return }
        UIApplication.shared.open(url)
    }

    private static func requestReviewWhenReady(attempt: Int = 0) {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }) else {
            guard attempt < 8 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                requestReviewWhenReady(attempt: attempt + 1)
            }
            return
        }
        SKStoreReviewController.requestReview(in: scene)
    }
}

private final class SquadLiveAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        SquadLiveAppShortcut.install()
        if let shortcutItem = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem {
            DispatchQueue.main.async {
                _ = SquadLiveAppShortcut.handle(shortcutItem)
            }
            return false
        }
        return true
    }

    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(SquadLiveAppShortcut.handle(shortcutItem))
    }
}
#endif

@main
struct SquadLiveApp: App {
#if os(iOS)
    @UIApplicationDelegateAdaptor(SquadLiveAppDelegate.self) private var appDelegate
#endif

    init() {
#if os(iOS)
        FirebaseApp.configure()
#endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .task {
#if os(iOS)
                    PromotionNotificationManager.bootstrap()
#endif
                }
        }
    }
}
