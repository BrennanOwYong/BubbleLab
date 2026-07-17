import type {
  BubbleOperationResult,
  ServiceBubbleParams,
  BubbleContext,
} from '@bubblelab/bubble-core';
import { BaseBubble } from './base-bubble-class.js';
import type {
  DatabaseMetadata,
  BubbleOperationMetadata,
  AppAuthMethods,
} from '@bubblelab/shared-schemas';

export abstract class ServiceBubble<
  TParams extends ServiceBubbleParams = ServiceBubbleParams,
  TResult extends BubbleOperationResult = BubbleOperationResult,
> extends BaseBubble<TParams, TResult> {
  /**
   * Doc-grounded side-effect metadata, declared PER OPERATION (IR-8).
   * Keys are the `operation` discriminator literals of the params schema.
   * Subclasses declare it from a colocated `<bubble>.metadata.ts` file so the
   * classifications (with source + citation) travel with the bubble.
   * Operations absent from the map fail safe to 'write' at runtime
   * (see BaseBubble.sideEffect).
   */
  static readonly operationMetadata?: BubbleOperationMetadata;

  /**
   * Doc-derived sign-in methods the app offers (IR-3/IR-4), most convenient
   * first once ranked. Declared from a colocated `<bubble>.auth-methods.ts`
   * file so every offered method travels with its citation. One app may offer
   * several methods (e.g. Slack: OAuth or a pasted bot token) and the user's
   * pick selects the bound CredentialType.
   */
  static readonly authMethods?: AppAuthMethods;

  public readonly type = 'service' as const;
  public authType?: 'oauth' | 'apikey' | 'none' | 'connection-string';

  constructor(params: unknown, context?: BubbleContext, instanceId?: string) {
    super(params, context, instanceId);
  }

  public abstract testCredential(): Promise<boolean>;

  /**
   * Abstract method to choose the appropriate credential based on bubble parameters
   * Should examine this.params to determine which credential to use from the injected credentials
   * Must be implemented by all service bubbles
   */
  protected abstract chooseCredential(): string | undefined;

  /**
   * Abstract method to get the metadata of the credential
   * Must be implemented by all service bubbles
   */
  // Optional method, only used for database bubbles
  async getCredentialMetadata(): Promise<DatabaseMetadata | undefined> {
    return undefined;
  }

  /**
   * Get the current parameters (credentials are excluded for security)
   * Use chooseCredential() method to access credentials in a controlled way
   */
  get currentParams(): Omit<TParams, 'credentials'> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { credentials, ...sanitized } = this.params as ServiceBubbleParams;
    return sanitized as Omit<TParams, 'credentials'>;
  }

  setParam<K extends keyof TParams>(
    paramName: K,
    paramValue: TParams[K]
  ): void {
    this.params[paramName] = paramValue;
  }

  /**
   * Get the current context
   */
  get currentContext(): BubbleContext | undefined {
    return this.context;
  }
}
