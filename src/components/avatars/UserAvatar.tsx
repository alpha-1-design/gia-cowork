import React from 'react';

/**
 * Original, hand-drawn character avatars.
 *
 * They are deliberately monochrome line art so they sit inside the neutral
 * desktop shell without turning the header into a sticker sheet. Each one is
 * drawn on the same 40×40 grid and uses `currentColor`, so light and dark
 * themes both work without a second asset set.
 */

export interface UserAvatarOption {
  id: string;
  label: string;
  hint: string;
}

export const USER_AVATARS: UserAvatarOption[] = [
  { id: 'nova', label: 'Nova', hint: 'Astronaut' },
  { id: 'kite', label: 'Kite', hint: 'Bird' },
  { id: 'mono', label: 'Mono', hint: 'Cat with headphones' },
  { id: 'circuit', label: 'Circuit', hint: 'Robot' },
  { id: 'fox', label: 'Fox', hint: 'Fox with a scarf' },
  { id: 'ghost', label: 'Ghost', hint: 'Friendly ghost' },
  { id: 'sol', label: 'Sol', hint: 'Sun in sunglasses' },
  { id: 'ink', label: 'Ink', hint: 'Ninja' },
  { id: 'initial', label: 'Initial', hint: 'Your first letter' },
];

const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg viewBox="0 0 40 40" width="100%" height="100%" aria-hidden="true" focusable="false">
    <circle cx="20" cy="20" r="18.5" fill="var(--gia-surface-3)" stroke="var(--gia-border-2)" strokeWidth="1" />
    <g
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      {children}
    </g>
  </svg>
);

const Nova = () => (
  <Frame>
    <circle cx="20" cy="21" r="10.5" />
    <rect x="12" y="15.5" width="16" height="10" rx="4.5" fill="var(--gia-surface)" />
    <path d="M15.5 19.5h3" opacity="0.55" />
    <path d="M20 10.5V7.5" />
    <circle cx="20" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
    <path d="M11.5 30.5c3 2 5.5 3 8.5 3s5.5-1 8.5-3" />
    <path d="M29 11l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" fill="currentColor" stroke="none" />
  </Frame>
);

const Kite = () => (
  <Frame>
    <circle cx="19" cy="20" r="9" />
    <path d="M28 20l6 2-6 2z" fill="currentColor" stroke="none" />
    <path d="M16 11c1-4 4-5 7-3" />
    <path d="M13 24c-3 1-4 4-2 6" />
    <path d="M14 28l-3 4" />
    <circle cx="23" cy="18" r="1.2" fill="currentColor" stroke="none" />
    <path d="M17 23c1.5 1 3.5 1 5 0" />
  </Frame>
);

const Mono = () => (
  <Frame>
    <circle cx="20" cy="21" r="9" />
    <path d="M13 14l-2-6 6 4" />
    <path d="M27 14l2-6-6 4" />
    <path d="M9 20c0-7 5-11 11-11s11 4 11 11" />
    <rect x="6.5" y="18" width="4.5" height="8" rx="2" fill="currentColor" stroke="none" />
    <rect x="29" y="18" width="4.5" height="8" rx="2" fill="currentColor" stroke="none" />
    <circle cx="17" cy="21" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="23" cy="21" r="1.1" fill="currentColor" stroke="none" />
    <path d="M20 23.5V25M18.5 25.5c1 .8 2 .8 3 0" />
    <path d="M13 23h-3M13 25.5h-3M27 23h3M27 25.5h3" opacity="0.55" />
  </Frame>
);

const Circuit = () => (
  <Frame>
    <rect x="10" y="12" width="20" height="16" rx="4" />
    <path d="M20 12V7.5" />
    <circle cx="20" cy="6.5" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="16" cy="19" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="24" cy="19" r="1.5" fill="currentColor" stroke="none" />
    <path d="M16 24h8" />
    <path d="M10 19H7M10 23H7M30 19h3M30 23h3" opacity="0.55" />
    <path d="M14 28v3M26 28v3" opacity="0.55" />
  </Frame>
);

const Fox = () => (
  <Frame>
    <path d="M11 14l2-7 6 5c.7-.3 1.3-.3 2 0l6-5 2 7c2 5 0 10-5 12-3 1.5-7 1.5-10 0-5-2-7-7-5-12z" />
    <path d="M16 23l4 3 4-3" />
    <circle cx="16" cy="19" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="24" cy="19" r="1.1" fill="currentColor" stroke="none" />
    <path d="M12 27c4 2 12 2 16 0" />
    <path d="M18 30l-1 3M22 30l1 3" opacity="0.55" />
  </Frame>
);

const Ghost = () => (
  <Frame>
    <path d="M12 29V18c0-5.5 3.5-9 8-9s8 3.5 8 9v11l-3-2.5-2.5 2.5-2.5-2.5-2.5 2.5L15 26.5 12 29z" />
    <circle cx="17" cy="19" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="23" cy="19" r="1.2" fill="currentColor" stroke="none" />
    <path d="M18.5 23c1 .8 2 .8 3 0" />
    <path d="M10 16l-2-2M30 16l2-2" opacity="0.5" />
  </Frame>
);

const Sol = () => (
  <Frame>
    <circle cx="20" cy="20" r="8" />
    <path d="M20 6v3M20 31v3M6 20h3M31 20h3M10 10l2 2M28 28l2 2M30 10l-2 2M12 28l-2 2" />
    <rect x="13" y="17" width="6" height="4.5" rx="1.5" fill="currentColor" stroke="none" />
    <rect x="21" y="17" width="6" height="4.5" rx="1.5" fill="currentColor" stroke="none" />
    <path d="M19 19h2" />
    <path d="M17 25c1.5 1 4.5 1 6 0" />
  </Frame>
);

const Ink = () => (
  <Frame>
    <circle cx="20" cy="20" r="9" />
    <path d="M11 17c3-1.5 15-1.5 18 0v6c-3 1.5-15 1.5-18 0z" fill="currentColor" stroke="none" />
    <circle cx="17" cy="20" r="1.1" fill="var(--gia-surface)" stroke="none" />
    <circle cx="23" cy="20" r="1.1" fill="var(--gia-surface)" stroke="none" />
    <path d="M29 19l5-3M29 22l5 3" />
    <path d="M13 27c2 1.5 4 2 7 2s5-.5 7-2" opacity="0.55" />
  </Frame>
);

const ART: Record<string, React.FC> = {
  nova: Nova,
  kite: Kite,
  mono: Mono,
  circuit: Circuit,
  fox: Fox,
  ghost: Ghost,
  sol: Sol,
  ink: Ink,
};

export interface UserAvatarProps {
  avatarId?: string;
  name?: string;
  size?: number;
  className?: string;
  title?: string;
}

export const UserAvatar: React.FC<UserAvatarProps> = ({
  avatarId,
  name,
  size = 32,
  className = '',
  title,
}) => {
  const id = avatarId || 'nova';
  const option = USER_AVATARS.find(a => a.id === id) ?? USER_AVATARS[0];
  const label = title || `${option.label} avatar`;

  if (id === 'initial') {
    const initial = name?.trim()?.[0]?.toUpperCase() || 'G';
    return (
      <span
        role="img"
        aria-label={label}
        className={`inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
        style={{
          width: size,
          height: size,
          background: 'var(--gia-surface-3)',
          border: '1px solid var(--gia-border-2)',
          color: 'var(--gia-text)',
          fontWeight: 700,
          fontSize: Math.max(10, Math.round(size * 0.4)),
          lineHeight: 1,
        }}
      >
        {initial}
      </span>
    );
  }

  const Art = ART[id] ?? Nova;
  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-flex shrink-0 ${className}`}
      style={{ width: size, height: size, color: 'var(--gia-text)' }}
    >
      <Art />
    </span>
  );
};

export default UserAvatar;
