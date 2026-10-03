import type { LucideIcon } from 'lucide-react';
import { Globe, Code2, FileText, Image, Cpu } from 'lucide-react';

/**
 * Tool taxonomy.
 *
 * Tools carry no category of their own, so this rule set is the single
 * classifier. It used to live inside ToolsCatalogSheet, which meant the
 * `/tools` slash command had no way to group anything and would have had to
 * duplicate (and eventually drift from) these rules.
 */
export const CATEGORY_RULES: { test: (id: string) => boolean; category: string; icon: LucideIcon }[] = [
  {
    test: id => ['web_search', 'read_url', 'browser_navigate', 'wikipedia', 'page_info', 'search_places', 'show_map', 'get_directions', 'web_scrape', 'http_request', 'network_scan', 'network_connectivity', 'network_detect'].includes(id),
    category: 'Web & Search',
    icon: Globe,
  },
  { test: id => /^(terminal_|code_|build_|zip_|github|ssh_|db_|filegen|create_pdf|read_pdf|document)/.test(id), category: 'Code & Dev', icon: Code2 },
  { test: id => /^(filesystem_|list_files|file_|rag_|neura_|undo_file)/.test(id), category: 'Files & Data', icon: FileText },
  { test: id => /^(image_|save_memory|forget_memory|request_clarification|summarize_|brain_|skill)/.test(id), category: 'AI & Creative', icon: Image },
  { test: () => true, category: 'System & Device', icon: Cpu },
];

export function categorizeTool(id: string): { category: string; icon: LucideIcon } {
  const rule = CATEGORY_RULES.find(r => r.test(id)) || CATEGORY_RULES[CATEGORY_RULES.length - 1];
  return { category: rule.category, icon: rule.icon };
}