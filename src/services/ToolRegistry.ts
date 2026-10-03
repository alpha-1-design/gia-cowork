import type { Tool } from './tools/types';

/**
 * A tool schema in the shape the provider builders consume.
 *
 * Mirrors the static `toolSchemas` record so the two can be merged without the
 * registry entries arriving as structurally different objects.
 */
export interface ProviderToolSchema {
  description: string;
  required: string[];
  properties: Record<string, unknown>;
}

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  public register(tool: Tool): void {
    if (this.tools.has(tool.id)) {
      console.warn(`Tool with id "${tool.id}" is already registered. Overwriting.`);
    }
    this.tools.set(tool.id, tool);
  }

  public get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  public unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  public getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  public getToolSchema(id: string): Tool['schema'] | null {
    const tool = this.get(id);
    return tool?.schema || null;
  }

  /**
   * Schemas as the model will receive them.
   *
   * The `description` is copied in from the Tool itself rather than omitted.
   * It used to return `tool.schema` alone, which carries only `properties` and
   * `required` — so every registry tool was advertised to the model with no
   * description at all. In practice that meant `web_search`, `terminal_run` and
   * `filesystem_write` reached the model as bare names: the model could see that
   * a tool existed but had no idea what it did or when to use it, and the most
   * reliable way to get the wrong tool called is to never tell it what the
   * right one is for.
   *
   * `required` is normalised to an array at the same time, because the provider
   * builders index into it directly and the Tool type leaves it optional.
   */
  public getAllToolSchemas(): Record<string, ProviderToolSchema> {
    const record: Record<string, ProviderToolSchema> = {};
    for (const tool of this.getAll()) {
      if (tool.schema) {
        record[tool.id] = {
          description: tool.description ?? '',
          required: tool.schema.required ?? [],
          properties: tool.schema.properties,
        };
      }
    }
    return record;
  }
}

// Export a singleton instance
export default new ToolRegistry();
