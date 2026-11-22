export const LIBRARY_ICONS = [
  'Globe2', 'Bookmark', 'BookOpen', 'Briefcase', 'Code2', 'Compass', 'Coffee', 'Heart',
  'Lightbulb', 'Music', 'Palette', 'Rocket', 'Star', 'Flame', 'Camera', 'Gem',
] as const;

export const LIBRARY_COLORS = ['blue', 'violet', 'emerald', 'amber', 'rose', 'cyan'] as const;

export function pickLibraryIcon() {
  return {
    fallbackIcon: LIBRARY_ICONS[Math.floor(Math.random() * LIBRARY_ICONS.length)],
    fallbackColor: LIBRARY_COLORS[Math.floor(Math.random() * LIBRARY_COLORS.length)],
  };
}
