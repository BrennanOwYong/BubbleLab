/**
 * Storage seam for the Contract KB (IR-11/12). The engine is storage-
 * agnostic: the API app provides a Drizzle-backed store; tests use the
 * in-memory store. Loads are Zod-validated by the engine so a corrupt store
 * fails loudly.
 */
import type { IntegrationKbDocument } from './document.js';

export interface ContractKbStore {
  /** Load the document for one integration, or undefined when none exists. */
  load(integration: string): Promise<IntegrationKbDocument | undefined>;
  /** Persist the full document for its integration (upsert semantics). */
  save(document: IntegrationKbDocument): Promise<void>;
}

/** In-memory store for tests and ephemeral use. */
export class InMemoryContractKbStore implements ContractKbStore {
  #documents = new Map<string, string>();

  async load(integration: string): Promise<IntegrationKbDocument | undefined> {
    const raw = this.#documents.get(integration);
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as IntegrationKbDocument;
  }

  async save(document: IntegrationKbDocument): Promise<void> {
    this.#documents.set(document.integration, JSON.stringify(document));
  }
}
