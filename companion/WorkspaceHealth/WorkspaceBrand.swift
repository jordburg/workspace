import SwiftUI
import UIKit

enum WorkspaceBrand {
    static let canvas = adaptive(light: (255, 255, 255), dark: (17, 17, 15))
    static let ink = adaptive(light: (17, 17, 15), dark: (243, 242, 238))
    static let muted = adaptive(light: (111, 110, 104), dark: (168, 167, 161))
    static let rule = adaptive(light: (217, 216, 210), dark: (69, 68, 63))
    static let surface = adaptive(light: (243, 242, 238), dark: (28, 28, 26))
    static let signal = adaptive(light: (185, 67, 49), dark: (207, 95, 75))

    private static func adaptive(
        light: (red: Int, green: Int, blue: Int),
        dark: (red: Int, green: Int, blue: Int)
    ) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat(value.red) / 255,
                green: CGFloat(value.green) / 255,
                blue: CGFloat(value.blue) / 255,
                alpha: 1
            )
        })
    }
}
