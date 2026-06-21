import { MessageCircle } from "lucide-react";
import { useMessenger } from "@/context/MessengerContext";
import { MessengerInbox } from "./MessengerInbox";
import { ChatPanel } from "./ChatPanel";

function AvatarBubble({
  initials,
  displayName,
  isOnline,
  unreadCount,
  onClick,
}: {
  initials: string;
  displayName: string;
  isOnline: boolean;
  unreadCount: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={displayName}
      onClick={onClick}
      className="relative flex-shrink-0 w-11 h-11 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white text-xs font-bold flex items-center justify-center shadow-md hover:scale-105 transition-transform select-none"
    >
      {initials.slice(0, 2)}
      {isOnline && (
        <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 border-2 border-[#1c2433] rounded-full" />
      )}
      {unreadCount > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-0.5">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
    </button>
  );
}

export function MessengerDock() {
  const {
    conversations,
    openPanels,
    onlineUserIds,
    inboxOpen,
    totalUnread,
    toggleInbox,
    openConversation,
  } = useMessenger();

  const chatHeads = conversations
    .filter((c) => c.otherUser)
    .slice(0, 3);

  return (
    <>
      <div className="fixed bottom-4 left-4 z-[9000] flex flex-col items-start gap-2 pointer-events-none">
        {inboxOpen && (
          <div className="pointer-events-auto">
            <MessengerInbox />
          </div>
        )}

        <div className="pointer-events-auto flex items-end gap-2 bg-[#1c2433]/95 backdrop-blur-sm px-3 py-2 rounded-full shadow-2xl border border-white/10">
          {chatHeads.map((conv) => {
            const other = conv.otherUser!;
            const isOnline = onlineUserIds.has(other.id);
            return (
              <AvatarBubble
                key={conv.id}
                initials={other.initials}
                displayName={other.displayName}
                isOnline={isOnline}
                unreadCount={conv.unreadCount}
                onClick={() => openConversation(conv.id)}
              />
            );
          })}

          <button
            type="button"
            onClick={toggleInbox}
            className="relative w-11 h-11 rounded-full bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-700 text-white flex items-center justify-center shadow-lg hover:scale-105 transition-transform flex-shrink-0"
            title="Messenger"
            aria-label="Messenger"
          >
            <MessageCircle size={22} fill="white" stroke="none" />
            {totalUnread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-0.5">
                {totalUnread > 99 ? "99+" : totalUnread}
              </span>
            )}
          </button>
        </div>
      </div>

      {openPanels.length > 0 && (
        <div className="fixed bottom-[88px] left-4 z-[8999] flex items-end gap-3 pointer-events-none">
          {[...openPanels].reverse().map((panel, idx) => (
            <div key={panel.conversationId} className="pointer-events-auto">
              <ChatPanel
                conversationId={panel.conversationId}
                minimized={panel.minimized}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
