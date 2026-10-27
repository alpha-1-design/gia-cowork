import React from 'react';
import { Check } from 'lucide-react';
import { USER_AVATARS, UserAvatar } from './UserAvatar';

interface UserAvatarPickerProps {
  value?: string;
  name?: string;
  onChange: (id: string) => void;
  compact?: boolean;
}

/**
 * A 3-column character picker. The selected tile gets the same raised surface
 * as the rest of the shell, plus a check mark so selection does not depend on
 * colour alone.
 */
export const UserAvatarPicker: React.FC<UserAvatarPickerProps> = ({
  value,
  name,
  onChange,
  compact = false,
}) => {
  const selected = value || 'nova';
  const avatarSize = compact ? 32 : 40;

  return (
    <div
      role="radiogroup"
      aria-label="Choose your avatar"
      className="grid grid-cols-3 gap-1.5"
    >
      {USER_AVATARS.map(option => {
        const active = selected === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${option.label} — ${option.hint}`}
            title={`${option.label} — ${option.hint}`}
            onClick={() => onChange(option.id)}
            className="relative flex flex-col items-center justify-center gap-1 rounded-md px-1.5 py-2 transition-colors tap-feedback"
            style={{
              background: active ? 'var(--gia-surface-3)' : 'var(--gia-overlay)',
              border: `1px solid ${active ? 'var(--gia-border-2)' : 'transparent'}`,
            }}
          >
            <UserAvatar avatarId={option.id} name={name} size={avatarSize} />
            <span
              className="text-[9px] font-medium leading-none"
              style={{ color: active ? 'var(--gia-text)' : 'var(--gia-muted)' }}
            >
              {option.label}
            </span>
            {active && (
              <span
                className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full"
                style={{ background: 'var(--gia-text)', color: 'var(--gia-accent-contrast)' }}
                aria-hidden="true"
              >
                <Check size={9} strokeWidth={3} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default UserAvatarPicker;
