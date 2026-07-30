/**
 * The original home page ("What do you want to automate?"), restored from
 * pre-effba78. The hero prompt box now feeds the Claude builder harness: the
 * home route creates an empty flow and opens /flow/:id where the conversation
 * panel streams the build. Template gallery, onboarding questionnaire and
 * voice input were removed with the Pearl backend and are not restored.
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import { ArrowUp } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'react-toastify';
import { useAuth } from '../hooks/useAuth';
import { useCreateBubbleFlow } from '../hooks/useCreateBubbleFlow';
import {
  INTEGRATIONS,
  SCRAPING_SERVICES,
  AI_MODELS,
  resolveLogoByName,
} from '../lib/integrations';
import { useRegisteredTools } from '../hooks/useRegisteredTools';
import { SignInModal } from '../components/SignInModal';

export interface DashboardPageProps {
  isStreaming: boolean;
  generationPrompt: string;
  setGenerationPrompt: (prompt: string) => void;
  onGenerateCode: () => void;
  autoShowSignIn?: boolean;
}

// Rotating placeholder messages
const PLACEHOLDER_MESSAGES = [
  'Read in my Google Calendar and send me an email with my upcoming events.',
  'Review open GitHub PRs in my repo and comment with suggested titles and descriptions.',
  'Analyze top tech stocks news and subredddits and send me a sentiment report.',
  'Find qualified prospects from Linkedin and log them to a sheet with an auto-drafted outreach message.',
  'Search for trending social media posts in my niche and send me an email analysis with how to apply to my product.',
];

export function DashboardPage({
  isStreaming,
  generationPrompt,
  setGenerationPrompt,
  onGenerateCode,
  autoShowSignIn = false,
}: DashboardPageProps) {
  const { isSignedIn } = useAuth();
  const navigate = useNavigate();
  const createBubbleFlowMutation = useCreateBubbleFlow();
  const { data: registeredTools } = useRegisteredTools();
  const [showSignInModal, setShowSignInModal] = useState(autoShowSignIn);
  const [currentPlaceholderIndex, setCurrentPlaceholderIndex] = useState(0);
  const [displayedPlaceholder, setDisplayedPlaceholder] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [savedPrompt, setSavedPrompt] = useState<string>(() => {
    // Load saved prompt from localStorage on initialization
    try {
      return localStorage.getItem('savedPrompt') || '';
    } catch (error) {
      console.warn('Failed to load saved prompt from localStorage:', error);
      return '';
    }
  });
  const [pendingGeneration, setPendingGeneration] = useState<boolean>(false);
  const [isCreatingFromScratch, setIsCreatingFromScratch] =
    useState<boolean>(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const isGenerateDisabled = useMemo(
    () => isStreaming || !generationPrompt?.trim(),
    [isStreaming, generationPrompt]
  );

  // Handler for "Start from scratch" button
  const handleBuildFromScratch = async () => {
    if (!isSignedIn) {
      setShowSignInModal(true);
      return;
    }

    setIsCreatingFromScratch(true);

    try {
      // Create a minimal empty flow template with a simple AI agent example
      const emptyFlowCode = `import { BubbleFlow, AIAgentBubble, type WebhookEvent } from '@bubblelab/bubble-core';

export interface Output {
  response: string;
}

export interface CustomWebhookPayload extends WebhookEvent {
  /**
   * The question or prompt to send to the AI agent.
   * @canBeFile false
   */
  query?: string;
}

export class UntitledFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: CustomWebhookPayload): Promise<Output> {
    const { query = 'What is the top news headline?' } = payload;

    const response = await this.askAIAgent(query);

    return { response };
  }

  // Sends the user query to an AI agent with web search capability and returns the response
  private async askAIAgent(query: string) {
    const agent = new AIAgentBubble({
      message: query,
      systemPrompt: 'You are a helpful assistant.',
      tools: [
        {
          name: 'web-search-tool',
          config: {
            limit: 1,
          },
        },
      ],
    });

    const result = await agent.action();

    if (!result.success) {
      throw new Error(\`AI Agent failed: \${result.error}\`);
    }

    return result.data.response;
  }
}
`;

      const createResult = await createBubbleFlowMutation.mutateAsync({
        name: 'Untitled',
        description: 'Empty flow created from scratch',
        code: emptyFlowCode,
        prompt: '',
        eventType: 'webhook/http',
        webhookActive: false,
      });

      // Navigate directly to the flow
      navigate({
        to: '/flow/$flowId',
        params: { flowId: createResult.id.toString() },
      });
    } catch (error) {
      console.error('Failed to create empty flow:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to create flow';
      toast.error(`Failed to create flow: ${errorMessage}`);
      setIsCreatingFromScratch(false);
    }
  };

  // Auto-resize the prompt textarea up to a max height, then show scrollbar
  const autoResize = (el: HTMLTextAreaElement) => {
    const maxHeightPx = 288; // 18rem
    el.style.height = 'auto';
    const newHeight = Math.min(el.scrollHeight, maxHeightPx);
    el.style.height = `${newHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeightPx ? 'auto' : 'hidden';
  };

  useEffect(() => {
    if (promptRef.current) {
      autoResize(promptRef.current);
    }
  }, [generationPrompt]);

  // Typing animation for placeholder
  useEffect(() => {
    const currentMessage = PLACEHOLDER_MESSAGES[currentPlaceholderIndex];

    const typingSpeed = 50; // ms per character when typing
    const deletingSpeed = 20; // ms per character when deleting (faster)
    const pauseAfterTyping = 2000; // pause after fully typed
    const pauseAfterDeleting = 500; // brief pause after deleting

    let timeout: NodeJS.Timeout;

    if (!isDeleting && displayedPlaceholder.length < currentMessage.length) {
      // Typing forward
      timeout = setTimeout(() => {
        setDisplayedPlaceholder(
          currentMessage.slice(0, displayedPlaceholder.length + 1)
        );
      }, typingSpeed);
    } else if (
      !isDeleting &&
      displayedPlaceholder.length === currentMessage.length
    ) {
      // Finished typing, pause then start deleting
      timeout = setTimeout(() => {
        setIsDeleting(true);
      }, pauseAfterTyping);
    } else if (isDeleting && displayedPlaceholder.length > 0) {
      // Deleting
      timeout = setTimeout(() => {
        setDisplayedPlaceholder(displayedPlaceholder.slice(0, -1));
      }, deletingSpeed);
    } else if (isDeleting && displayedPlaceholder.length === 0) {
      // Finished deleting, move to next message
      timeout = setTimeout(() => {
        setIsDeleting(false);
        setCurrentPlaceholderIndex(
          (prevIndex) => (prevIndex + 1) % PLACEHOLDER_MESSAGES.length
        );
      }, pauseAfterDeleting);
    }

    return () => clearTimeout(timeout);
  }, [displayedPlaceholder, isDeleting, currentPlaceholderIndex]);

  // Hide sign in modal when user signs in and restore saved prompt
  useEffect(() => {
    if (isSignedIn && savedPrompt) {
      setShowSignInModal(false);
      setGenerationPrompt(savedPrompt);
      setPendingGeneration(true);

      // Clear saved state
      setSavedPrompt('');
      localStorage.removeItem('savedPrompt');
    } else if (isSignedIn) {
      setShowSignInModal(false);
    }
  }, [isSignedIn, savedPrompt, setGenerationPrompt]);

  // Handle pending generation after state is updated
  useEffect(() => {
    if (pendingGeneration && generationPrompt.trim()) {
      setPendingGeneration(false);
      onGenerateCode();
    }
  }, [pendingGeneration, generationPrompt, onGenerateCode]);

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0a] text-gray-100 font-sans selection:bg-purple-500/30 relative overflow-hidden">
      {/* Background Effects */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-purple-900/10 rounded-[100%] blur-[100px] pointer-events-none" />

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto relative z-10">
        <div className="max-w-6xl w-full mx-auto space-y-10 py-12 px-4 sm:px-6">
          {/* Header */}
          <div className="text-center space-y-6">
            <div className="text-center mb-8">
              {/* Discord Community Link */}
              <div className="mb-6 text-center animate-fade-in-up">
                <div className="relative inline-block group">
                  <a
                    href="https://discord.com/invite/PkJvcU2myV"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/5 text-gray-400 hover:text-white text-xs font-medium rounded-full transition-all duration-300 backdrop-blur-md hover:shadow-[0_0_15px_rgba(255,255,255,0.05)] hover:-translate-y-0.5"
                  >
                    <svg
                      className="w-3.5 h-3.5 text-[#5865F2] group-hover:scale-110 transition-transform duration-300"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                    </svg>
                    Join Discord Community
                  </a>
                  {/* Tooltip */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-10">
                    Get instant help, request features, join community!
                  </div>
                </div>
              </div>
              <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight pb-2 animate-fade-in-up delay-100 drop-shadow-sm">
                What do you want to automate?
              </h1>
            </div>
          </div>

          {/* HERO PROMPT SECTION */}
          <div className="w-full max-w-3xl mx-auto animate-fade-in-up delay-200 relative z-20 -mt-4">
            <div className="bg-[#1a1a1a] rounded-2xl p-4 shadow-2xl border border-white/5 relative group transition-all duration-300 hover:border-white/10 focus-within:border-purple-500/30 focus-within:ring-1 focus-within:ring-purple-500/30">
              <textarea
                ref={promptRef}
                placeholder={displayedPlaceholder}
                value={generationPrompt}
                onChange={(e) => {
                  setGenerationPrompt(e.target.value);
                  if (!e.target.value.trim() && savedPrompt) {
                    setSavedPrompt('');
                    localStorage.removeItem('savedPrompt');
                  }
                }}
                onInput={(e) => autoResize(e.currentTarget)}
                className="bg-transparent text-gray-100 text-sm w-full min-h-[8rem] max-h-[18rem] placeholder-gray-400 resize-none focus:outline-none focus:ring-0 p-0 overflow-y-auto thin-scrollbar"
                onKeyDown={(e) => {
                  // Tab key: autocomplete the current placeholder
                  if (e.key === 'Tab' && !generationPrompt.trim()) {
                    e.preventDefault();
                    const fullMessage =
                      PLACEHOLDER_MESSAGES[currentPlaceholderIndex];
                    setGenerationPrompt(fullMessage);
                    // Stop the animation by resetting to a stable state
                    setDisplayedPlaceholder(fullMessage);
                    setIsDeleting(false);
                    return;
                  }

                  if (e.key === 'Enter' && e.ctrlKey && !isStreaming) {
                    if (!isSignedIn) {
                      if (generationPrompt.trim()) {
                        setSavedPrompt(generationPrompt);
                        localStorage.setItem('savedPrompt', generationPrompt);
                      }
                      setShowSignInModal(true);
                      return;
                    }
                    onGenerateCode();
                  }
                }}
              />
              {/* Generate Button - Inside the prompt container */}
              <div className="flex justify-end mt-4 items-end gap-3">
                <div className="flex flex-col items-end">
                  <button
                    type="button"
                    onClick={() => {
                      if (!isSignedIn) {
                        if (generationPrompt.trim()) {
                          setSavedPrompt(generationPrompt);
                          localStorage.setItem('savedPrompt', generationPrompt);
                        }
                        setShowSignInModal(true);
                        return;
                      }
                      onGenerateCode();
                    }}
                    disabled={isGenerateDisabled}
                    className={`w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 ${
                      isGenerateDisabled
                        ? 'bg-gray-700/40 border border-gray-700/60 cursor-not-allowed text-gray-500'
                        : 'bg-white text-gray-900 border border-white/80 hover:bg-gray-100 hover:border-gray-300 shadow-lg hover:scale-105'
                    }`}
                  >
                    <ArrowUp className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Prompt Suggestions row (template categories removed with the
                Pearl backend; Import JSON + Start from scratch remain) */}
            <div className="mt-4">
              <div className="flex flex-wrap gap-3 justify-center">
                {/* Import JSON button */}
                <button
                  type="button"
                  onClick={() => {
                    const importPrefix =
                      'Convert this JSON workflow to a Gluu workflow:\n\n [Paste your JSON here]';
                    setGenerationPrompt(importPrefix);
                    // Focus textarea and place cursor at end
                    setTimeout(() => {
                      if (promptRef.current) {
                        promptRef.current.focus();
                        promptRef.current.setSelectionRange(
                          importPrefix.length,
                          importPrefix.length
                        );
                      }
                    }, 0);
                  }}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium transition-all duration-200 rounded-lg text-gray-400 hover:text-gray-200"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
                  </svg>
                  Import JSON from n8n
                </button>
                {/* Start from empty bubble flow button */}
                <button
                  type="button"
                  onClick={handleBuildFromScratch}
                  disabled={isStreaming || isCreatingFromScratch}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium transition-all duration-200 rounded-lg ${
                    isStreaming || isCreatingFromScratch
                      ? 'text-gray-600 cursor-not-allowed'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                  {isCreatingFromScratch ? 'Creating...' : 'Start from scratch'}
                </button>
              </div>
            </div>
          </div>

          {/* Current Supported Integrations Section */}
          <div className="mt-10 w-full max-w-3xl mx-auto space-y-4">
            <div className="flex items-center gap-2 flex-col md:flex-row">
              <p className="text-xs font-semibold tracking-wide text-gray-500 whitespace-nowrap w-48 flex-shrink-0 text-center md:text-left">
                Third Party Integrations
              </p>
              <div className="flex flex-wrap gap-3 items-center justify-center md:justify-start">
                {INTEGRATIONS.map((integration) => (
                  <div key={integration.name} className="relative group">
                    <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 hover:border-white/20 hover:bg-white/10 transition-all duration-200">
                      <img
                        src={integration.file}
                        alt={`${integration.name} logo`}
                        className="h-5 w-5"
                        loading="lazy"
                      />
                    </div>
                    {/* Tooltip */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-10">
                      {integration.name}
                    </div>
                  </div>
                ))}
                {/* Tools added through Add a Tool (live registry) */}
                {(registeredTools ?? []).map((tool) => {
                  const logo =
                    resolveLogoByName(tool.displayName) ??
                    resolveLogoByName(tool.service);
                  return (
                    <div key={tool.name} className="relative group">
                      <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 hover:border-white/20 hover:bg-white/10 transition-all duration-200">
                        {logo ? (
                          <img
                            src={logo.file}
                            alt={`${tool.displayName} logo`}
                            className="h-5 w-5"
                            loading="lazy"
                          />
                        ) : (
                          <span className="text-xs font-bold text-gray-200">
                            {tool.displayName.charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                      {/* Tooltip */}
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-10">
                        {tool.displayName} — {tool.operations.length} operations
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-col md:flex-row">
              <p className="text-xs font-semibold tracking-wide text-gray-500 whitespace-nowrap w-48 flex-shrink-0 text-center md:text-left">
                Scraping
              </p>
              <div className="flex flex-wrap gap-3 items-center">
                {SCRAPING_SERVICES.map((service) => (
                  <div key={service.name} className="relative group">
                    <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 hover:border-white/20 hover:bg-white/10 transition-all duration-200">
                      <img
                        src={service.file}
                        alt={`${service.name} logo`}
                        className="h-5 w-5"
                        loading="lazy"
                      />
                    </div>
                    {/* Tooltip */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-10">
                      {service.name}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 md:flex-row flex-col">
              <p className="text-xs font-semibold tracking-wide text-gray-500 whitespace-nowrap w-48 flex-shrink-0 text-center md:text-left">
                AI Models and Agents
              </p>
              <div className="flex flex-wrap gap-3 items-center">
                {AI_MODELS.map((model) => (
                  <div key={model.name} className="relative group">
                    <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 hover:border-white/20 hover:bg-white/10 transition-all duration-200">
                      <img
                        src={model.file}
                        alt={`${model.name} logo`}
                        className="h-5 w-5"
                        loading="lazy"
                      />
                    </div>
                    {/* Tooltip */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-10">
                      {model.name}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sign In Modal - shows when user is not signed in */}
      <SignInModal
        isVisible={showSignInModal}
        onClose={() => setShowSignInModal(false)}
      />
    </div>
  );
}
