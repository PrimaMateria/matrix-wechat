import { useState } from "react";
export function Avatar({ id, label }: { id: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="avatar" aria-label={label}>
      {!failed && id ? (
        <img
          src={"/api/avatar?" + new URLSearchParams({ id })}
          alt=""
          onError={() => setFailed(true)}
        />
      ) : (
        label.slice(0, 1)
      )}
    </span>
  );
}
