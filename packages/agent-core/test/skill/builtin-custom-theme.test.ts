import { describe, expect, it } from 'vitest';

import { CUSTOM_THEME_SKILL, SkillRegistry, registerBuiltinSkills } from '../../src/skill';

describe('builtin skill: custom-theme', () => {
  it('has the expected identity and inline metadata', () => {
    expect(CUSTOM_THEME_SKILL.name).toBe('custom-theme');
    expect(CUSTOM_THEME_SKILL.source).toBe('builtin');
    expect(CUSTOM_THEME_SKILL.description.length).toBeGreaterThan(0);
    expect(CUSTOM_THEME_SKILL.metadata.type).toBe('inline');
  });

  it('is model-invocable (does not disable model invocation)', () => {
    expect(CUSTOM_THEME_SKILL.metadata.disableModelInvocation).not.toBe(true);
  });

  it('pins the docs token reference and points users at ~/.kimi-code/themes and /theme', () => {
    const content = CUSTOM_THEME_SKILL.content;
    expect(content).toContain('customization/themes.html');
    expect(content).toContain('FetchURL');
    expect(content).toContain('~/.kimi-code/themes');
    expect(content).toContain('/theme');
    // every documented token should be named so the model knows the full set
    for (const token of [
      'primary',
      'accent',
      'text',
      'textStrong',
      'textDim',
      'textMuted',
      'border',
      'borderFocus',
      'success',
      'warning',
      'error',
      'diffAdded',
      'diffRemoved',
      'diffAddedStrong',
      'diffRemovedStrong',
      'diffGutter',
      'diffMeta',
      'roleUser',
    ]) {
      expect(content).toContain(`\`${token}\``);
    }
  });

  it('registers through registerBuiltinSkills and shows up as model-invocable', () => {
    const registry = new SkillRegistry();
    registerBuiltinSkills(registry);

    expect(registry.getSkill('custom-theme')).toBeDefined();
    expect(
      registry.listInvocableSkills().some((skill) => skill.name === 'custom-theme'),
    ).toBe(true);
  });
});
