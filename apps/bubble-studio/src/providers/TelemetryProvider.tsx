/**
 * Root telemetry wiring (mounted once in main.tsx around RouterProvider):
 * - installs the fetch interceptor (every API call → api.call event)
 * - installs delegated data-track click tracking
 * - installs window error + unhandledrejection handlers
 * - subscribes to the router for automatic page.view events
 *
 * TelemetryErrorBoundary wraps the whole tree and emits app.error_boundary
 * for render-phase crashes React catches before window.onerror fires.
 */
import { Component, useEffect } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { AnyRouter } from '@tanstack/react-router';
import {
  installClickTracking,
  installFetchInterceptor,
  installGlobalErrorHandlers,
  track,
} from '../lib/telemetry';

let initialPageViewSent = false;

export function TelemetryProvider({
  router,
  children,
}: {
  router: AnyRouter;
  children: ReactNode;
}) {
  useEffect(() => {
    installFetchInterceptor();
    installClickTracking();
    installGlobalErrorHandlers();

    if (!initialPageViewSent) {
      initialPageViewSent = true;
      track('page.view', { path: window.location.pathname });
    }

    const unsubscribe = router.subscribe('onResolved', (event) => {
      track('page.view', {
        path: event.toLocation.pathname,
        fromPath: event.fromLocation?.pathname,
      });
    });
    return unsubscribe;
  }, [router]);

  return <>{children}</>;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class TelemetryErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    track('app.error_boundary', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            gap: '1rem',
            color: '#e5e7eb',
            background: '#111827',
            fontFamily: 'sans-serif',
          }}
        >
          <p>Something went wrong. The error was reported.</p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              border: '1px solid #4b5563',
              background: '#1f2937',
              color: '#e5e7eb',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
