import SwiftUI

@main
struct WorkspaceHealthApp: App {
    @StateObject private var store = WorkspaceStore()

    var body: some Scene {
        WindowGroup {
            WorkspaceRootView()
                .environmentObject(store)
        }
    }
}
