//
//  SquadLiveApp.swift
//  SquadLive
//
//  Created by liu on 2026/7/14.
//

import SwiftUI
#if os(iOS)
import FirebaseCore
#endif

@main
struct SquadLiveApp: App {
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
