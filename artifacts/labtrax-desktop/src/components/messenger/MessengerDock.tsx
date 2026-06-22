import { MessageCircle } from "lucide-react";
import { useMessenger } from "@/context/MessengerContext";
import { MessengerInbox } from "./MessengerInbox";
import { ChatPanel } from "./ChatPanel";

export function MessengerDock() {
  const {
    openPanels,
    inboxOpen,
    totalUnread,
    toggleInbox,
  } = useMessenger();

  return (
    <>
      <div className="fixed bottom-4 left-4 z-[9000] flex flex-col items-start gap-2 pointer-events-none">
        {inboxOpen && (
          <div className="pointer-events-auto">
            <MessengerInbox />
          </div>
        )}

        <button
          type="button"
          onClick={toggleInbox}
          className="pointer-events-auto relative w-11 h-11 rounded-full bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-700 text-white flex items-center justify-center shadow-lg hover:scale-105 transition-transform flex-shrink-0"
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
