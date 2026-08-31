import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Banner, Button, Card, Field, SectionLabel } from "./Primitives";

interface Account {
  id: number;
  email: string;
  created_at: string;
}

export function AccountPanel({
  onClose,
  onDeleted,
  onSignedOut,
}: {
  onClose: () => void;
  onDeleted: () => void;
  onSignedOut: () => void;
}) {
  const [account, setAccount] = useState<Account | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    api.get<Account>("/api/auth/me").then(setAccount).catch((e) => {
      setError(e instanceof ApiError ? e.message : String(e));
    });
  }, []);

  /// Signing out is not the same as leaving: the token is revoked server side
  /// first, so a captured copy stops working. If that call fails the local
  /// token is cleared anyway -- refusing to sign out because the network is
  /// down would strand the user on an account they asked to leave.
  async function signOut() {
    setSigningOut(true);
    try {
      await api.post("/api/auth/logout", {});
    } catch {
      /* revoked or unreachable; either way this device is done with it */
    }
    onSignedOut();
  }

  async function deleteAccount() {
    if (!password || pending) return;
    setPending(true);
    setError(null);
    try {
      await api.delete<void>("/api/auth/me", { password });
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-bg/55 p-4 backdrop-blur-sm sm:items-center sm:justify-center">
      <Card className="w-full max-w-md">
        <div className="flex items-start justify-between gap-4">
          <div>
            <SectionLabel>Account</SectionLabel>
            <div className="display mt-1 text-subheading">Your Account</div>
          </div>
          <button onClick={onClose} className="text-sm text-faint hover:text-ink" aria-label="Close Account Settings">Close</button>
        </div>

        {account ? (
          <div className="mt-5 rounded-control bg-raised px-4 py-3">
            <div className="text-body-sm font-medium text-ink">{account.email}</div>
            <div className="mt-1 font-mono text-micro uppercase tracking-label text-faint">
              Account #{account.id}
            </div>
          </div>
        ) : (
          <div className="mt-5 text-sm text-muted">Loading Account Details…</div>
        )}

        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={signOut} pending={signingOut}>
            Sign Out
          </Button>
        </div>

        <div className="mt-7 border-t border-line pt-5">
          <SectionLabel>Delete Account</SectionLabel>
          <p className="mt-2 text-caption leading-relaxed text-muted">
            This permanently removes your goals, plans, sessions, and account. Enter your password to confirm.
          </p>
          <Field
            className="mt-4"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Your password"
          />
          {error && <div className="mt-3"><Banner>{error}</Banner></div>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="danger" arrow={false} pending={pending} disabled={!password} onClick={deleteAccount}>
              Delete Permanently
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
