import SwiftUI

struct MemoRow: View {
    let memo: MemoPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(memo.title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.flowixForeground)
                    .lineLimit(2)

                Spacer()

                Text(memo.updatedAt)
                    .font(.system(size: 13, weight: .regular, design: .rounded))
                    .foregroundStyle(Color.flowixSecondary)
                    .lineLimit(1)
            }

            Text(memo.preview)
                .font(.system(size: 15))
                .foregroundStyle(Color.flowixSecondary)
                .lineLimit(2)

            HStack(spacing: 8) {
                Label(memo.createdAt, systemImage: "clock")
                if memo.containsTodo {
                    Label("待办", systemImage: "checklist")
                }
                if memo.favorited {
                    Image(systemName: "pin.fill")
                        .foregroundStyle(Color.flowixAccent)
                        .accessibilityLabel("已置顶")
                }
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color.flowixSecondary.opacity(0.9))
        }
        .frame(minHeight: 104, alignment: .leading)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}
