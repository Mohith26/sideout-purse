'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@sideout/ui';

/** A secret handed out once: shown in a copyable box until the operator dismisses it, never again. */
export function RevealOnce({ title, secret, children, onDismiss }: { title: string; secret: string; children?: ReactNode; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="reveal" role="status">
      <span className="so-notice__title">{title}</span>
      <code className="reveal__secret">{secret}</code>
      {children === undefined ? null : <span className="so-field__hint">{children}</span>}
      <div className="so-actions">
        <Button
          small
          onClick={() => {
            navigator.clipboard
              .writeText(secret)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button small onClick={onDismiss}>
          I have stored it
        </Button>
      </div>
    </div>
  );
}
