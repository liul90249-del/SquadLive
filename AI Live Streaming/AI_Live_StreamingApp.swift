//
//  SquadLiveApp.swift
//  SquadLive
//
//  Created by liu on 2026/7/14.
//

import SwiftUI

@main
struct SquadLiveApp: App {
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
