"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { baseSteps, evaluateLead, LeadProfile, LeadStep } from "@/lib/leadAgent";

type Sender = "agent" | "user";

type Message = {
  id: string;
  sender: Sender;
  content: string;
  suggestions?: string[];
  meta?: {
    type?: "question" | "info" | "summary";
  };
};

type AgentState = {
  stepIndex: number;
  lead: LeadProfile;
  messages: Message[];
  status: "collecting" | "complete";
};

const initialAgentMessage: Message = {
  id: "intro",
  sender: "agent",
  content:
    "Hey there — I'm your lead concierge. I'll capture the essentials in a few quick questions.",
  meta: { type: "info" },
  suggestions: ["Sounds good!", "Let's do it", "Can we skip ahead?"],
};

type AgentAction =
  | { type: "INIT" }
  | { type: "PUSH_MESSAGE"; payload: Message }
  | { type: "BULK_MESSAGES"; payload: Message[] }
  | { type: "ADVANCE"; leadUpdates: Partial<LeadProfile>; followUp?: string }
  | { type: "RETRY"; message: string }
  | { type: "COMPLETE"; followUp?: string }
  | { type: "RESET" };

const reducer = (state: AgentState, action: AgentAction): AgentState => {
  switch (action.type) {
    case "INIT":
      return {
        stepIndex: 0,
        lead: {},
        messages: [initialAgentMessage, questionForStep(baseSteps[0])],
        status: "collecting",
      };
    case "PUSH_MESSAGE":
      return {
        ...state,
        messages: [...state.messages, action.payload],
      };
    case "BULK_MESSAGES":
      return {
        ...state,
        messages: [...state.messages, ...action.payload],
      };
    case "ADVANCE": {
      const nextLead = { ...state.lead, ...action.leadUpdates };
      const nextStepIndex = state.stepIndex + 1;
      const followUpMessages: Message[] = [];

      if (action.followUp) {
        followUpMessages.push(agentMessage(action.followUp));
      }

      const nextStep = baseSteps[nextStepIndex];

      if (!nextStep) {
        return {
          ...state,
          lead: nextLead,
          messages: [...state.messages, ...followUpMessages],
          stepIndex: nextStepIndex,
        };
      }

      return {
        ...state,
        lead: nextLead,
        messages: [
          ...state.messages,
          ...followUpMessages,
          questionForStep(nextStep, nextStepIndex),
        ],
        stepIndex: nextStepIndex,
      };
    }
    case "RETRY":
      return {
        ...state,
        messages: [
          ...state.messages,
          agentMessage(action.message, undefined, { type: "info" }),
          questionForStep(baseSteps[state.stepIndex], state.stepIndex),
        ],
      };
    case "COMPLETE": {
      const followUpMessages = action.followUp ? [agentMessage(action.followUp)] : [];
      return {
        ...state,
        status: "complete",
        messages: [...state.messages, ...followUpMessages],
      };
    }
    case "RESET":
      return {
        stepIndex: 0,
        lead: {},
        messages: [initialAgentMessage, questionForStep(baseSteps[0])],
        status: "collecting",
      };
    default:
      return state;
  }
};

const agentMessage = (
  content: string,
  suggestions?: string[],
  meta?: Message["meta"],
): Message => ({
  id: generateId(),
  sender: "agent",
  content,
  suggestions,
  meta,
});

const userMessage = (content: string): Message => ({
  id: generateId(),
  sender: "user",
  content,
});

const questionForStep = (step: LeadStep, index?: number): Message => {
  const content =
    index === undefined || index === 0
      ? step.question
      : `${step.question}${step.helper ? `\n${step.helper}` : ""}`;

  return {
    id: generateId(),
    sender: "agent",
    content,
    suggestions: step.suggestions,
    meta: { type: "question" },
  };
};

const upsertLeadInStorage = (lead: LeadProfile, score: number) => {
  const payload = {
    ...lead,
    score,
    storedAt: new Date().toISOString(),
  };

  try {
    const existingRaw = window.localStorage.getItem("leadgen:leads");
    const existing = existingRaw ? (JSON.parse(existingRaw) as typeof payload[]) : [];
    const updated = [payload, ...existing].slice(0, 25);
    window.localStorage.setItem("leadgen:leads", JSON.stringify(updated));
    window.dispatchEvent(
      new CustomEvent("leadgen:new-lead", {
        detail: payload,
      }),
    );
  } catch (error) {
    console.warn("Unable to persist lead snapshot", error);
  }
};

export const LeadAgent = () => {
  const [state, dispatch] = useReducer(reducer, undefined, (): AgentState => ({
    stepIndex: 0,
    lead: {},
    messages: [initialAgentMessage, questionForStep(baseSteps[0])],
    status: "collecting",
  }));
  const [input, setInput] = useState("");

  const insights = useMemo(() => evaluateLead(state.lead), [state.lead]);

  useEffect(() => {
    if (state.status === "complete") {
      upsertLeadInStorage(state.lead, insights.score);
    }
  }, [insights.score, state.lead, state.status]);

  const activeSuggestions = useMemo(() => {
    const lastAgentMessage = [...state.messages].reverse().find((m) => m.sender === "agent");
    return lastAgentMessage?.suggestions ?? [];
  }, [state.messages]);

  const handleSubmit = (value?: string) => {
    const message = typeof value === "string" ? value : input;
    const trimmed = message.trim();
    if (!trimmed) return;

    setInput("");
    dispatch({ type: "PUSH_MESSAGE", payload: userMessage(trimmed) });

    if (state.status === "complete") {
      dispatch({
        type: "BULK_MESSAGES",
        payload: [
          agentMessage("Appreciate the extra context. Noted for the handoff.", undefined, {
            type: "info",
          }),
        ],
      });
      return;
    }

    const currentStep = baseSteps[state.stepIndex];
    if (!currentStep) return;

    const result = currentStep.parse(trimmed, state.lead);
    if (!result.success) {
      dispatch({ type: "RETRY", message: result.retryMessage });
      return;
    }

    const nextLead = { ...state.lead, ...result.updates };
    const willComplete = state.stepIndex + 1 >= baseSteps.length;

    dispatch({ type: "ADVANCE", leadUpdates: result.updates, followUp: result.followUp });

    if (willComplete) {
      dispatch({
        type: "COMPLETE",
        followUp: "That's everything I need. Here's a quick snapshot of the opportunity.",
      });

      dispatch({
        type: "BULK_MESSAGES",
        payload: [
          agentMessage(renderSummary(nextLead), undefined, { type: "summary" }),
          agentMessage("Need anything else captured? Just type it in."),
        ],
      });
    }
  };

  const resetConversation = () => {
    dispatch({ type: "RESET" });
  };

  return (
    <div className="flex flex-col gap-6 md:grid md:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] md:gap-8 h-full">
      <div className="flex h-full flex-col gap-4 rounded-3xl border border-neutral-800/40 bg-neutral-950/60 p-6 shadow-[0_25px_80px_-40px_rgba(59,130,246,0.45)] backdrop-blur">
        <header className="flex flex-col gap-1">
          <p className="text-sm uppercase tracking-[0.3em] text-sky-400/80">Lead Concierge</p>
          <h1 className="text-2xl md:text-3xl font-semibold text-white">
            Automated lead generation agent
          </h1>
          <p className="text-sm text-neutral-300">
            Capture discovery context, score the opportunity, and prep follow-up actions — all in
            one flow.
          </p>
        </header>
        <div className="relative flex-1 overflow-hidden rounded-2xl border border-white/5 bg-black/40">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-sky-500/5 via-transparent to-purple-500/10" />
          <div className="relative flex h-full flex-col">
            <div className="flex-1 space-y-4 overflow-y-auto p-5 pr-4">
              {state.messages.map((message) => (
                <ChatBubble key={message.id} sender={message.sender}>
                  {message.content.split("\n").map((line, idx) => (
                    <p key={idx} className="leading-relaxed text-sm text-neutral-200">
                      {line}
                    </p>
                  ))}
                </ChatBubble>
              ))}
            </div>

            {activeSuggestions.length > 0 && (
              <div className="flex flex-wrap gap-2 px-5 pb-3">
                {activeSuggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    className="rounded-full border border-sky-500/50 bg-sky-500/10 px-4 py-1.5 text-xs font-medium text-sky-200 transition hover:bg-sky-500/20"
                    type="button"
                    onClick={() => handleSubmit(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleSubmit();
              }}
              className="border-t border-white/5 bg-black/60 p-4"
            >
              <div className="flex items-start gap-2">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  className="min-h-[60px] flex-1 resize-none rounded-2xl border border-white/10 bg-neutral-900/80 px-4 py-3 text-sm text-white placeholder:text-neutral-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                  placeholder="Type your response…"
                />
                <button
                  type="submit"
                  className="mt-1 inline-flex h-11 min-w-[64px] items-center justify-center rounded-xl bg-sky-500 px-4 text-sm font-semibold text-black transition hover:bg-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/60"
                >
                  Send
                </button>
              </div>
            </form>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            className="rounded-full border border-white/10 px-4 py-2 text-xs font-medium uppercase tracking-widest text-neutral-400 transition hover:border-sky-500/60 hover:text-sky-200"
            onClick={resetConversation}
          >
            Restart flow
          </button>
          <LeadScoreBadge score={insights.score} label={insights.scoreLabel} />
        </div>
      </div>

      <aside className="flex h-full flex-col gap-4">
        <InsightPanel lead={state.lead} insights={insights} />
        <SavedLeadsCard />
      </aside>
    </div>
  );
};

type ChatBubbleProps = {
  sender: Sender;
  children: React.ReactNode;
};

const ChatBubble = ({ sender, children }: ChatBubbleProps) => {
  const isAgent = sender === "agent";
  return (
    <div className={`flex ${isAgent ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] rounded-2xl border px-4 py-3 text-sm ${
          isAgent
            ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
        }`}
      >
        {children}
      </div>
    </div>
  );
};

const LeadScoreBadge = ({ score, label }: { score: number; label: string }) => (
  <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs uppercase tracking-[0.25em] text-neutral-300">
    <span className="flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_15px_rgba(74,222,128,0.9)]" />
    {label} • {Math.round(score)}
  </div>
);

const InsightPanel = ({
  lead,
  insights,
}: {
  lead: LeadProfile;
  insights: ReturnType<typeof evaluateLead>;
}) => {
  const details = [
    { label: "Company", value: lead.companyName ?? "—" },
    { label: "Industry", value: lead.industry ?? "—" },
    { label: "Team size", value: lead.companySize ?? "—" },
    { label: "Goal", value: lead.primaryGoal ?? "—" },
    { label: "Pain points", value: lead.painPoints ?? "—" },
    { label: "Budget", value: lead.budgetRange ?? formatBudget(lead.budgetValue) ?? "—" },
    { label: "Timeline", value: lead.timeline ?? formatTimeline(lead.timelineWeeks) ?? "—" },
    { label: "Tech stack", value: lead.techStack ?? "—" },
    { label: "Contact", value: lead.contactName ?? "—" },
    { label: "Email", value: lead.contactEmail ?? "—" },
  ];

  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-neutral-950/70 p-6 text-sm text-neutral-200 shadow-[0_12px_60px_-40px_rgba(59,130,246,0.9)] backdrop-blur">
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-[0.4em] text-sky-400/80">Snapshot</p>
        <h2 className="text-xl font-semibold text-white">Opportunity brief</h2>
      </header>

      <div className="rounded-2xl border border-sky-500/30 bg-sky-500/10 p-4">
        <p className="text-xs uppercase tracking-[0.25em] text-sky-200/80">Score</p>
        <p className="mt-1 text-2xl font-semibold text-white">
          {Math.round(insights.score)} / 100
          <span className="ml-2 text-sm font-medium text-sky-200">{insights.scoreLabel}</span>
        </p>
        <p className="mt-2 text-xs text-sky-100/80">{insights.urgencyLabel}</p>
      </div>

      <dl className="grid grid-cols-1 gap-3 text-xs capitalize md:grid-cols-2">
        {details.map((item) => (
          <div key={item.label} className="flex flex-col gap-1 rounded-xl bg-white/5 p-3">
            <dt className="text-[10px] uppercase tracking-[0.3em] text-neutral-400">
              {item.label}
            </dt>
            <dd className="text-sm normal-case text-white/90">{item.value}</dd>
          </div>
        ))}
      </dl>

      <section className="flex flex-col gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-emerald-400">Playbook</p>
          <p className="mt-2 text-sm text-neutral-200">{insights.recommendedPlaybook}</p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-amber-400">Risks</p>
          <ul className="mt-2 space-y-1 text-sm text-neutral-200">
            {insights.risks.length > 0 ? (
              insights.risks.map((risk) => (
                <li key={risk} className="flex items-start gap-2">
                  <span className="mt-[6px] h-1.5 w-1.5 rounded-full bg-amber-400" />
                  <span>{risk}</span>
                </li>
              ))
            ) : (
              <li className="text-neutral-400">No major red flags detected.</li>
            )}
          </ul>
        </div>

        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-sky-400">Next steps</p>
          <ul className="mt-2 space-y-1 text-sm text-neutral-200">
            {insights.nextSteps.map((step) => (
              <li key={step} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-sky-400" />
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {lead.notes && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <p className="text-xs uppercase tracking-[0.3em] text-neutral-300">Additional notes</p>
          <p className="mt-2 whitespace-pre-line text-sm text-neutral-100">{lead.notes}</p>
        </div>
      )}
    </section>
  );
};

const SavedLeadsCard = () => {
  const [leads, setLeads] = useState<
    Array<LeadProfile & { score: number; storedAt: string }>
  >([]);

  useEffect(() => {
    const load = () => {
      try {
        const raw = window.localStorage.getItem("leadgen:leads");
        if (!raw) {
          setLeads([]);
          return;
        }
        const parsed = JSON.parse(raw) as Array<LeadProfile & { score: number; storedAt: string }>;
        setLeads(parsed);
      } catch (error) {
        console.warn("Unable to load saved leads", error);
      }
    };

    load();

    const handler = () => load();
    window.addEventListener("leadgen:new-lead", handler);
    return () => window.removeEventListener("leadgen:new-lead", handler);
  }, []);

  const exportLatestLead = () => {
    if (leads.length === 0) return;
    const [latest] = leads;
    const blob = new Blob([JSON.stringify(latest, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(latest.companyName ?? "lead").toLowerCase().replace(/\s+/g, "-")}-lead.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-neutral-950/60 p-6 text-sm text-neutral-200 backdrop-blur">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-sky-300/80">Handoff</p>
          <h2 className="text-lg font-semibold text-white">Latest captures</h2>
        </div>
        <button
          type="button"
          onClick={exportLatestLead}
          className="rounded-full border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-100 transition hover:bg-sky-500/20"
        >
          Export JSON
        </button>
      </header>

      <div className="mt-4 space-y-3">
        {leads.length === 0 ? (
          <p className="text-xs text-neutral-400">
            Leads captured in this session will appear here for quick handoff.
          </p>
        ) : (
          leads.slice(0, 3).map((lead) => (
            <article
              key={`${lead.contactEmail ?? lead.companyName}-${lead.storedAt}`}
              className="flex flex-col gap-1 rounded-2xl border border-white/5 bg-white/5 px-4 py-3"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-white">
                  {lead.companyName ?? "Unnamed lead"}
                </p>
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.3em] text-sky-200">
                  {Math.round(lead.score)}
                </span>
              </div>
              <p className="text-xs text-neutral-300">
                {lead.primaryGoal ?? "Goal not captured yet"}
              </p>
              <p className="text-[11px] uppercase tracking-[0.3em] text-neutral-500">
                {lead.storedAt
                  ? new Date(lead.storedAt).toLocaleString(undefined, {
                      hour12: false,
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "Just now"}
              </p>
            </article>
          ))
        )}
      </div>
    </section>
  );
};

const formatBudget = (value?: number) => {
  if (!value) return undefined;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${value}`;
};

const formatTimeline = (weeks?: number) => {
  if (!weeks) return undefined;
  if (weeks < 4) return `${weeks} weeks`;
  if (weeks % 4 === 0) return `${weeks / 4} months`;
  return `${weeks} weeks`;
};

const renderSummary = (lead: LeadProfile) => {
  const lines = [
    lead.companyName ? `• ${lead.companyName} in ${lead.industry ?? "unknown vertical"}` : undefined,
    lead.primaryGoal ? `• Goal: ${lead.primaryGoal}` : undefined,
    lead.painPoints ? `• Challenge: ${lead.painPoints}` : undefined,
    lead.budgetRange
      ? `• Budget comfort zone: ${lead.budgetRange}`
      : lead.budgetValue
        ? `• Budget comfort zone: ~$${lead.budgetValue.toLocaleString()}`
        : undefined,
    lead.timeline ? `• Timeline: ${lead.timeline}` : undefined,
    lead.contactName ? `• Contact: ${lead.contactName} (${lead.contactEmail ?? "email pending"})` : undefined,
  ];

  return `Quick recap:\n${lines.filter(Boolean).join("\n")}`;
};

export default LeadAgent;

const generateId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10);
