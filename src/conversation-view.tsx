import { useKeyboard } from "@opentui/react";
import { useEffect, useState } from "react";
import type { Conversation } from "./acp";
import { acpRequest } from "./acp-host";
import { color } from "./tui";
import { useLatest } from "./use-latest";

function statusLine(conversation: Conversation | undefined): string {
  if (!conversation) return "Connecting";
  switch (conversation.session.activity) {
    case "working":
      return "Working · ctrl-c stop";
    case "waiting":
      return "Needs input · ctrl-c stop";
    case "idle":
      return "Ready · enter send";
    case undefined:
      return "Connection unavailable";
  }
}

export function ConversationView({ id, onBack }: { id: string; onBack: () => void }) {
  const [conversation, setConversation] = useState<Conversation>();
  const [text, getText, setText] = useLatest("");
  const [problem, setProblem] = useState("");
  const [pollProblem, setPollProblem] = useState("");
  const [approvalIndex, getApprovalIndex, setApprovalIndex] = useLatest(0);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const value = await acpRequest<Conversation>(`/sessions/${id}`);
        if (!stopped) {
          setConversation(value);
          setPollProblem("");
        }
      } catch (error) {
        if (!stopped) {
          setPollProblem(error instanceof Error ? error.message : "Session unavailable");
          setConversation(
            (previous) =>
              previous && { ...previous, session: { ...previous.session, activity: undefined }, approvals: [] },
          );
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 200);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id]);
  const approval = conversation?.approvals[0];
  const execute = async (action: string, body: object) => {
    try {
      await acpRequest(`/sessions/${id}/${action}`, body);
      setProblem("");
      return true;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Request failed");
      return false;
    }
  };
  useKeyboard((key) => {
    if (key.name === "escape") return onBack();
    if (key.ctrl && key.name === "c") {
      void execute("cancel", {});
      return;
    }
    if (approval) {
      if (key.name === "up") setApprovalIndex(Math.max(0, getApprovalIndex() - 1));
      if (key.name === "down") setApprovalIndex(Math.min(approval.options.length - 1, getApprovalIndex() + 1));
      if (key.name === "return") {
        const option = approval.options[Math.min(getApprovalIndex(), approval.options.length - 1)];
        if (option) void execute("approve", { approvalId: approval.id, optionId: option.optionId });
        setApprovalIndex(0);
      }
      return;
    }
  });
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={color.bg}>
      <text fg={color.orange} height={1} flexShrink={0}>
        {conversation?.session.title ?? "Connecting…"} · {conversation?.session.agent}
      </text>
      <scrollbox flexGrow={1} flexShrink={1} minHeight={0} stickyScroll stickyStart="bottom">
        {conversation?.messages.map((message) => (
          <text
            key={message.id}
            fg={message.role === "user" ? color.peach : message.role === "tool" ? color.fgDim : color.fg}
          >
            {message.role}: {message.text}
          </text>
        ))}
      </scrollbox>
      {approval ? (
        <box flexDirection="column" height={approval.options.length + 2} flexShrink={0}>
          <text fg={color.yellow}>Needs input: {approval.title}</text>
          {approval.options.map((option, index) => (
            <text key={option.optionId} fg={color.yellow}>
              {index === approvalIndex ? "› " : "  "}
              {option.name}
            </text>
          ))}
          <text fg={color.fgDim}>↑↓ choose · enter confirm · esc list</text>
        </box>
      ) : (
        <>
          <text height={1} flexShrink={0} fg={conversation?.session.activity === "idle" ? color.green : color.fgDim}>
            {statusLine(conversation)} · esc list
          </text>
          <input
            value={text}
            maxLength={3500}
            flexShrink={0}
            focused
            placeholder="Message agent"
            textColor={color.fgBright}
            backgroundColor={color.bg}
            focusedBackgroundColor={color.bg}
            onInput={setText}
            onSubmit={() => {
              const prompt = getText();
              if (!prompt.trim()) return;
              void execute("prompt", { text: prompt }).then((sent) => {
                if (sent && getText() === prompt) setText("");
              });
            }}
          />
        </>
      )}
      {(problem || pollProblem || conversation?.problem) && (
        <text height={1} flexShrink={0} fg={color.red}>
          {problem || pollProblem || conversation?.problem}
        </text>
      )}
    </box>
  );
}
