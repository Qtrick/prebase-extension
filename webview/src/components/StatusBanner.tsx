import type { HostStatus } from '@prebase/protocol';
import { ThinkingOrb } from '../vendor/ThinkingOrb';

const LOADING: HostStatus[] = [
  'initializing',
  'engine_starting',
  'loading_graph',
  'updating_graph',
  'indexing_history',
  'retrying',
];

interface Props {
  status: HostStatus;
  message: string;
  onRetry?: () => void;
  recoverable?: boolean;
}

export function StatusBanner({ status, message, onRetry, recoverable }: Props) {
  const loading = LOADING.includes(status);
  const errorish =
    status === 'request_failed' ||
    status === 'engine_disconnected' ||
    status === 'analysis_unavailable' ||
    status === 'no_workspace';

  return (
    <div
      className={`status-banner${errorish ? ' is-error' : ''}${loading ? ' is-loading' : ''}`}
      role={errorish ? 'alert' : 'status'}
      aria-live="polite"
    >
      {loading ? <ThinkingOrb state="working" size={20} aria-label="Working" /> : null}
      <span className="status-text">{message}</span>
      {recoverable && onRetry ? (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
