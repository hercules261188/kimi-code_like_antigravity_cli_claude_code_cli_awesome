import type { SkillRegistry } from '../registry';
import { CUSTOM_THEME_SKILL } from './custom-theme';
import { MCP_CONFIG_SKILL } from './mcp-config';
import { UPDATE_CONFIG_SKILL } from './update-config';

export function registerBuiltinSkills(registry: SkillRegistry): void {
  registry.registerBuiltinSkill(MCP_CONFIG_SKILL);
  registry.registerBuiltinSkill(UPDATE_CONFIG_SKILL);
  registry.registerBuiltinSkill(CUSTOM_THEME_SKILL);
}

export { MCP_CONFIG_SKILL, UPDATE_CONFIG_SKILL, CUSTOM_THEME_SKILL };
