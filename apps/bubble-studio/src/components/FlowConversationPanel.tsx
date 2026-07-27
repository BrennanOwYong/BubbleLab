/**
 * Read-only view of the conversation that built this flow.
 *
 * Renders the CoffeeMessage thread persisted on the flow's
 * metadata.conversationMessages (user prompts, clarification Q&A, the
 * approved plan) in chat style. Data arrives via useBubbleFlow -> GET
 * /bubble-flow/:id -> metadata, parsed by parseConversationMessages.
 */
import { useMemo } from 'react';
import { CheckCircle2, MessageSquare, XCircle } from 'lucide-react';
import type {
  ClarificationQuestion,
  CoffeeMessage,
} from '@bubblelab/shared-schemas';
import { useBubbleFlow } from '../hooks/useBubbleFlow';
import { parseConversationMessages } from '../utils/flowChecklist';

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function MessageShell({
  align,
  label,
  timestamp,
  children,
}: {
  align: 'left' | 'right';
  label: string;
  timestamp: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-1 ${align === 'right' ? 'items-end' : 'items-start'}`}
    >
      <div className="flex items-center gap-2 text-[10px] text-gray-500">
        <span className="font-medium text-gray-400">{label}</span>
        {timestamp && <span>{formatTimestamp(timestamp)}</span>}
      </div>
      <div
        className={`max-w-[92%] rounded-lg border px-3 py-2 text-sm leading-relaxed ${
          align === 'right'
            ? 'bg-blue-600/15 border-blue-600/40 text-blue-100'
            : 'bg-[#0f1115] border-[#30363d] text-gray-200'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function QuestionBlock({ question }: { question: ClarificationQuestion }) {
  return (
    <div className="mt-2 first:mt-0">
      <p className="text-sm text-gray-200">{question.question}</p>
      <ul className="mt-1 space-y-0.5">
        {question.choices.map((choice) => (
          <li key={choice.id} className="text-xs text-gray-400 pl-3">
            • {choice.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConversationMessage({
  message,
  questionsById,
}: {
  message: CoffeeMessage;
  questionsById: Map<string, ClarificationQuestion>;
}) {
  switch (message.type) {
    case 'user':
      return (
        <MessageShell align="right" label="You" timestamp={message.timestamp}>
          <p className="whitespace-pre-wrap">{message.content}</p>
        </MessageShell>
      );

    case 'assistant':
      return (
        <MessageShell
          align="left"
          label="Assistant"
          timestamp={message.timestamp}
        >
          <p className="whitespace-pre-wrap">{message.content}</p>
        </MessageShell>
      );

    case 'clarification_request':
      return (
        <MessageShell
          align="left"
          label="Assistant asked"
          timestamp={message.timestamp}
        >
          {message.questions.map((question) => (
            <QuestionBlock key={question.id} question={question} />
          ))}
        </MessageShell>
      );

    case 'clarification_response': {
      const answered = Object.entries(message.answers);
      return (
        <MessageShell
          align="right"
          label="You answered"
          timestamp={message.timestamp}
        >
          <ul className="space-y-1.5">
            {answered.map(([questionId, choiceIds]) => {
              const question =
                message.originalQuestions?.find((q) => q.id === questionId) ??
                questionsById.get(questionId);
              const labels = choiceIds.map(
                (choiceId) =>
                  question?.choices.find((c) => c.id === choiceId)?.label ??
                  choiceId
              );
              return (
                <li key={questionId}>
                  {question && (
                    <p className="text-xs text-blue-200/70">
                      {question.question}
                    </p>
                  )}
                  <p className="text-sm">{labels.join(', ')}</p>
                </li>
              );
            })}
          </ul>
        </MessageShell>
      );
    }

    case 'plan':
      return (
        <MessageShell
          align="left"
          label="Proposed plan"
          timestamp={message.timestamp}
        >
          <p className="text-sm text-gray-200">{message.plan.summary}</p>
          <ol className="mt-2 space-y-1.5 list-decimal list-inside">
            {message.plan.steps.map((step, index) => (
              <li key={index} className="text-sm text-gray-300">
                <span className="font-medium text-gray-200">{step.title}</span>
                {step.description && (
                  <p className="ml-4 text-xs text-gray-400">
                    {step.description}
                  </p>
                )}
              </li>
            ))}
          </ol>
          {message.plan.estimatedBubbles.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {message.plan.estimatedBubbles.map((bubble) => (
                <span
                  key={bubble}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-700/50 text-gray-400"
                >
                  {bubble}
                </span>
              ))}
            </div>
          )}
        </MessageShell>
      );

    case 'plan_approval':
      return (
        <div className="flex justify-end">
          <div
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border ${
              message.approved
                ? 'text-green-300 border-green-600/40 bg-green-600/10'
                : 'text-amber-300 border-amber-600/40 bg-amber-600/10'
            }`}
          >
            {message.approved ? (
              <CheckCircle2 className="w-3.5 h-3.5" />
            ) : (
              <XCircle className="w-3.5 h-3.5" />
            )}
            {message.approved
              ? 'You approved the plan'
              : 'You requested changes to the plan'}
            {message.comment && (
              <span className="text-gray-400">— {message.comment}</span>
            )}
          </div>
        </div>
      );

    case 'context_request':
      return (
        <MessageShell
          align="left"
          label="Assistant requested context"
          timestamp={message.timestamp}
        >
          <p className="text-sm">{message.request.description}</p>
        </MessageShell>
      );

    case 'context_response':
      return (
        <div className="flex justify-end">
          <p className="text-xs text-gray-500 italic">
            {message.answer.status === 'success'
              ? 'You shared the requested context'
              : message.answer.status === 'rejected'
                ? 'You skipped the context request'
                : 'Context gathering failed'}
          </p>
        </div>
      );

    case 'system':
      return (
        <p className="text-center text-xs text-gray-500 italic px-4">
          {message.content}
        </p>
      );

    case 'tool_result':
      return (
        <p className="text-xs text-gray-600 pl-1">
          Used {message.toolName}
          {message.success ? '' : ' (failed)'}
        </p>
      );

    default:
      return null;
  }
}

export function FlowConversationPanel({ flowId }: { flowId: number | null }) {
  const { data: currentFlow } = useBubbleFlow(flowId);

  const messages = useMemo(
    () => parseConversationMessages(currentFlow?.metadata),
    [currentFlow?.metadata]
  );

  // Lookup so clarification answers can echo their question text even when
  // originalQuestions was not persisted on the response message.
  const questionsById = useMemo(() => {
    const map = new Map<string, ClarificationQuestion>();
    for (const message of messages) {
      if (message.type === 'clarification_request') {
        for (const question of message.questions) {
          map.set(question.id, question);
        }
      }
    }
    return map;
  }, [messages]);

  if (!flowId || messages.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[#1a1a1a]">
        <div className="text-center text-gray-500 px-6">
          <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="text-sm">No conversation saved for this flow</p>
          <p className="text-xs text-gray-600 mt-1">
            Flows built through the generator keep their planning conversation
            here
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#1a1a1a]">
      <div className="px-4 py-3 border-b border-[#30363d] flex-shrink-0">
        <h3 className="text-sm font-semibold text-gray-100">
          How this flow was built
        </h3>
        <p className="text-xs text-gray-500 mt-0.5">
          The conversation that produced this flow, from first prompt to
          approved plan
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((message) => (
          <ConversationMessage
            key={message.id}
            message={message}
            questionsById={questionsById}
          />
        ))}
      </div>
    </div>
  );
}
