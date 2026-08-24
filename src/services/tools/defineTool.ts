import { z } from 'zod';
import type { Tool, ToolResult } from './types';

/**
 * defineTool — the single way to author a tool.
 *
 * One source of truth for arguments:
 *  - `input` (a zod schema) derives the JSON schema the model sees
 *    (via zod v4's built-in `z.toJSONSchema`), so there is no separate
 *    hand-written schema to keep in sync.
 *  - the same schema validates args at runtime — `execute` receives
 *    **typed, validated** arguments, and a malformed call gets a clean
 *    `ToolResult` error instead of a runtime crash.
 *
 * The legacy pattern (hand-written `schema` on `Tool` + manual
 * `args.x as string` casts + the parallel map in `brain/toolSchemas.ts`)
 * still works, but new tools should use this. Migrating a tool to
 * `defineTool` also gives it a real schema for the model (several legacy
 * tools had none), which makes the whole tool loop more reliable.
 *
 * Example:
 *   defineTool({
 *     id: 'echo',
 *     name: 'echo',
 *     description: 'Echo text back.',
 *     input: z.object({ text: z.string().describe('Text to echo') }),
 *     execute: ({ text }) => ({ success: true, content: text }),
 *   });
 */

export interface DefineToolOptions<S extends z.ZodTypeAny> {
  id: string;
  name: string;
  description: string;
  /** Zod schema for the tool's arguments. Derives the model JSON schema AND validates at runtime. */
  input?: S;
  /** Plain-text category used by the command palette / tool catalogs. */
  category?: string;
  execute: (args: z.infer<S>, context?: import('./types').ToolContext) => Promise<ToolResult> | ToolResult;
}

export function defineTool<S extends z.ZodTypeAny>(opts: DefineToolOptions<S>): Tool {
  const { id, name, description, input, category, execute } = opts;

  let schema: Tool['schema'];
  if (input) {
    try {
      const jsonSchema = z.toJSONSchema(input) as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      schema = {
        type: 'object',
        properties: jsonSchema.properties ?? {},
        required: jsonSchema.required ?? [],
      };
    } catch {
      schema = undefined; // never let schema derivation break tool registration
    }
  }

  return {
    id,
    name,
    description,
    ...(category ? { category } : {}),
    ...(schema ? { schema } : {}),
    execute: async (rawArgs, context) => {
      if (!input) {
        return execute(rawArgs as z.infer<S>, context);
      }
      const parsed = input.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          success: false,
          content: '',
          error: `Invalid arguments for "${id}": ${parsed.error.issues.map(i => i.message).join('; ')}`,
        };
      }
      return execute(parsed.data, context);
    },
  };
}
