'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, Input } from '@sideout/ui';

/** The point-in-time query: an instant in UTC becomes `?asOf=` on the account page, which asks `balanceOf(asOf)`. */
export function AsOfPicker({ path, current }: { path: string; current: string | undefined }) {
  const router = useRouter();
  const [value, setValue] = useState(current === undefined ? '' : current.slice(0, 19));
  return (
    <form
      className="filters"
      onSubmit={(event) => {
        event.preventDefault();
        if (value === '') {
          router.push(path);
          return;
        }
        const at = new Date(`${value}Z`);
        if (Number.isNaN(at.getTime())) return;
        router.push(`${path}?asOf=${encodeURIComponent(at.toISOString())}`);
      }}
    >
      <Field id="as-of" label="Balance as of (UTC)" hint="Inclusive: an entry posted at this instant counts.">
        <Input id="as-of" type="datetime-local" step={1} value={value} onChange={(event) => setValue(event.target.value)} />
      </Field>
      <Button type="submit">Query</Button>
      {current === undefined ? null : (
        <Button
          onClick={() => {
            setValue('');
            router.push(path);
          }}
        >
          Clear
        </Button>
      )}
    </form>
  );
}
