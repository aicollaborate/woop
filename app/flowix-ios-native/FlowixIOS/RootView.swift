import SwiftUI

struct RootView: View {
    var body: some View {
        NavigationStack {
            LibraryView()
        }
        .tint(Color.flowixAccent)
    }
}

extension Color {
    static let flowixAccent = Color(red: 0.20, green: 0.24, blue: 0.30)
    static let flowixForeground = Color(red: 0.12, green: 0.14, blue: 0.17)
    static let flowixBackground = Color(red: 0.985, green: 0.985, blue: 0.98)
    static let flowixLibrarySurface = Color(red: 236 / 255, green: 235 / 255, blue: 230 / 255)
    static let flowixSecondary = Color(red: 0.43, green: 0.45, blue: 0.48)
    static let flowixCard = Color.white.opacity(0.92)

    // Mirrors the fixed Rock palette used by the Web mobile drawer.
    static let flowixMobileBackground = Color(red: 236 / 255, green: 235 / 255, blue: 230 / 255)
    static let flowixMobileCard = Color.white
    static let flowixMobileAccountCard = Color(red: 252 / 255, green: 251 / 255, blue: 246 / 255)
    static let flowixNavigationButtonBackground = Color(red: 252 / 255, green: 251 / 255, blue: 246 / 255)
    static let flowixMobileNotebookCard = Color(red: 0.975, green: 0.975, blue: 0.968)
    static let flowixMobileForeground = Color(red: 0.18, green: 0.19, blue: 0.18)
    static let flowixMobileMuted = Color(red: 0.945, green: 0.945, blue: 0.938)
    static let flowixMobileMutedForeground = Color(red: 0.47, green: 0.47, blue: 0.44)
    static let flowixMobileHairline = Color.black.opacity(0.07)
    static let flowixMobileBrand = Color(red: 0.68, green: 0.32, blue: 0.22)
    static let flowixMobilePrimary = Color(red: 0.33, green: 0.32, blue: 0.30)
    static let flowixMobilePrimaryForeground = Color(red: 0.97, green: 0.97, blue: 0.96)
    static let flowixMobileDestructive = Color(red: 0.84, green: 0.31, blue: 0.25)
    static let flowixMobileSuccess = Color(red: 0.43, green: 0.53, blue: 0.44)
    static let flowixMobileSaved = flowixMobileSuccess

    // Native sidebar palette: warm dark gray with warm light foregrounds.
    static let flowixSidebarBackground = Color(red: 59 / 255, green: 57 / 255, blue: 54 / 255)
    static let flowixSidebarCard = Color(red: 72 / 255, green: 69 / 255, blue: 65 / 255)
    static let flowixSidebarNotebookCard = Color(red: 68 / 255, green: 66 / 255, blue: 62 / 255)
    static let flowixSidebarMuted = Color(red: 82 / 255, green: 79 / 255, blue: 74 / 255)
    static let flowixSidebarForeground = Color(red: 0.96, green: 0.95, blue: 0.92)
    static let flowixSidebarMutedForeground = Color(red: 0.79, green: 0.77, blue: 0.72)
    static let flowixSidebarHairline = Color.white.opacity(0.14)
    static let flowixSidebarBrand = Color(red: 0.82, green: 0.45, blue: 0.32)
}
