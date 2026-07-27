import React from 'react';
import { UserButton } from '@clerk/clerk-react';
import { Link } from '@tanstack/react-router';
import {
  KeyRound,
  PanelLeft,
  PanelLeftClose,
  Home,
  Workflow,
  User,
  Settings,
  PlugZap,
} from 'lucide-react';
import { useUser } from '../hooks/useUser';
import { SignedIn } from './AuthComponents';
import { DISABLE_AUTH } from '../env';

export interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  ref: React.RefObject<HTMLDivElement | null>;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, onToggle, ref }) => {
  const { user } = useUser();

  return (
    <div
      ref={ref}
      className={`fixed inset-y-0 left-0 z-40 bg-[#0f1115] border-r border-[#30363d] transition-all duration-200 ${
        isOpen ? 'w-56' : 'w-16'
      }`}
    >
      <div className="h-full flex flex-col pt-2 px-2 items-stretch gap-2">
        {/* Sidebar toggle (favicon) */}
        <button
          type="button"
          onClick={onToggle}
          className="relative group flex items-center h-12 rounded-lg hover:bg-[#21262d] focus:outline-none"
          aria-label={isOpen ? 'Close sidebar' : 'Open sidebar'}
        >
          <span className="w-12 flex-none flex justify-center p-2">
            {isOpen ? (
              <PanelLeftClose className="w-6 h-6 text-gray-200" />
            ) : (
              <PanelLeft className="w-6 h-6 text-gray-200" />
            )}
          </span>
          {/* Gluu text when expanded */}
          {isOpen && (
            <span className="text-lg font-semibold text-white group-hover:text-gray-400 transition-colors">
              Gluu
            </span>
          )}
          {/* Tooltip when expanded */}
          {isOpen && (
            <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 whitespace-nowrap rounded bg-[#0f1115] px-2 py-1 text-xs text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity z-50">
              Close Sidebar
            </span>
          )}
          {/* Tooltip when collapsed */}
          {!isOpen && (
            <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 whitespace-nowrap rounded bg-[#0f1115] px-2 py-1 text-xs text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity">
              Open Sidebar
            </span>
          )}
        </button>

        {/* Home button (icon only, shows label on hover) */}
        <div className="mt-2">
          <div className="relative group">
            <Link
              to="/home"
              activeProps={{
                className:
                  'w-full flex items-center rounded-lg bg-[#21262d] text-gray-200 transition-colors',
              }}
              inactiveProps={{
                className:
                  'w-full flex items-center rounded-lg hover:bg-[#21262d] text-gray-400 hover:text-gray-200 transition-colors',
              }}
              aria-label="Home"
            >
              {/* Fixed icon column */}
              <span className="w-12 flex-none flex justify-center p-2">
                <Home className="w-5 h-5" />
              </span>
              {/* Expanding label column */}
              <span
                className={`text-sm overflow-hidden whitespace-nowrap transition-all duration-200 ${
                  isOpen
                    ? 'opacity-100 max-w-[160px] pr-3'
                    : 'opacity-0 max-w-0'
                }`}
              >
                Home
              </span>
            </Link>
            {/* Tooltip when collapsed */}
            {!isOpen && (
              <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 whitespace-nowrap rounded bg-[#0f1115] px-2 py-1 text-xs text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity">
                Home
              </span>
            )}
          </div>
        </div>

        {/* My Flows button (icon only, shows label on hover) */}
        <div className="mt-2">
          <div className="relative group">
            <Link
              to="/flows"
              activeProps={{
                className:
                  'w-full flex items-center rounded-lg bg-[#21262d] text-gray-200 transition-colors',
              }}
              inactiveProps={{
                className:
                  'w-full flex items-center rounded-lg hover:bg-[#21262d] text-gray-400 hover:text-gray-200 transition-colors',
              }}
              aria-label="My Flows"
            >
              {/* Fixed icon column */}
              <span className="w-12 flex-none flex justify-center p-2">
                <Workflow className="w-5 h-5" />
              </span>
              {/* Expanding label column */}
              <span
                className={`text-sm overflow-hidden whitespace-nowrap transition-all duration-200 ${
                  isOpen
                    ? 'opacity-100 max-w-[160px] pr-3'
                    : 'opacity-0 max-w-0'
                }`}
              >
                My Flows
              </span>
            </Link>
            {/* Tooltip when collapsed */}
            {!isOpen && (
              <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 whitespace-nowrap rounded bg-[#0f1115] px-2 py-1 text-xs text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity">
                My Flows
              </span>
            )}
          </div>
        </div>

        {/* Add a Tool button (icon only, shows label on hover) */}
        <div className="mt-2">
          <div className="relative group">
            <Link
              to="/add-tool"
              activeProps={{
                className:
                  'w-full flex items-center rounded-lg bg-[#21262d] text-gray-200 transition-colors',
              }}
              inactiveProps={{
                className:
                  'w-full flex items-center rounded-lg hover:bg-[#21262d] text-gray-400 hover:text-gray-200 transition-colors',
              }}
              aria-label="Add a Tool"
            >
              {/* Fixed icon column */}
              <span className="w-12 flex-none flex justify-center p-2">
                <PlugZap className="w-5 h-5" />
              </span>
              {/* Expanding label column */}
              <span
                className={`text-sm overflow-hidden whitespace-nowrap transition-all duration-200 ${
                  isOpen
                    ? 'opacity-100 max-w-[160px] pr-3'
                    : 'opacity-0 max-w-0'
                }`}
              >
                Add a Tool
              </span>
            </Link>
            {/* Tooltip when collapsed */}
            {!isOpen && (
              <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 whitespace-nowrap rounded bg-[#0f1115] px-2 py-1 text-xs text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity">
                Add a Tool
              </span>
            )}
          </div>
        </div>

        {/* Credentials button (icon only, shows label on hover) */}
        <div className="mt-2">
          <div className="relative group">
            <Link
              to="/credentials"
              activeProps={{
                className:
                  'w-full flex items-center rounded-lg bg-[#21262d] text-gray-200 transition-colors',
              }}
              inactiveProps={{
                className:
                  'w-full flex items-center rounded-lg hover:bg-[#21262d] text-gray-400 hover:text-gray-200 transition-colors',
              }}
              aria-label="Credentials"
            >
              {/* Fixed icon column */}
              <span className="w-12 flex-none flex justify-center p-2">
                <KeyRound className="w-5 h-5" />
              </span>
              {/* Expanding label column */}
              <span
                className={`text-sm overflow-hidden whitespace-nowrap transition-all duration-200 ${
                  isOpen
                    ? 'opacity-100 max-w-[160px] pr-3'
                    : 'opacity-0 max-w-0'
                }`}
              >
                Credentials
              </span>
            </Link>
            {/* Tooltip when collapsed */}
            {!isOpen && (
              <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 whitespace-nowrap rounded bg-[#0f1115] px-2 py-1 text-xs text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity">
                Credentials
              </span>
            )}
          </div>
        </div>

        {/* Settings button */}
        <div className="mt-2">
          <div className="relative group">
            <Link
              to="/settings"
              activeProps={{
                className:
                  'w-full flex items-center rounded-lg bg-[#21262d] text-gray-200 transition-colors',
              }}
              inactiveProps={{
                className:
                  'w-full flex items-center rounded-lg hover:bg-[#21262d] text-gray-400 hover:text-gray-200 transition-colors',
              }}
              aria-label="Settings"
            >
              {/* Fixed icon column */}
              <span className="w-12 flex-none flex justify-center p-2">
                <Settings className="w-5 h-5" />
              </span>
              {/* Expanding label column */}
              <span
                className={`text-sm overflow-hidden whitespace-nowrap transition-all duration-200 ${
                  isOpen
                    ? 'opacity-100 max-w-[160px] pr-3'
                    : 'opacity-0 max-w-0'
                }`}
              >
                Settings
              </span>
            </Link>
            {/* Tooltip when collapsed */}
            {!isOpen && (
              <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 whitespace-nowrap rounded bg-[#0f1115] px-2 py-1 text-xs text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity">
                Settings
              </span>
            )}
          </div>
        </div>

        {/* Spacer to push bottom content down */}
        <div className="flex-1" />

        {/* Divider */}
        <div className="px-3 py-2">
          <div className="border-t border-[#30363d]" />
        </div>

        {/* Profile button at sidebar bottom */}
        <div className="mb-3">
          <SignedIn>
            <div className="w-full flex items-center rounded-lg hover:bg-[#21262d] text-gray-400 hover:text-gray-200 transition-colors">
              {/* Fixed icon column with Clerk UserButton or mock avatar */}
              <span className="w-12 flex-none flex justify-center p-2">
                {DISABLE_AUTH ? (
                  // Mock avatar when auth is disabled
                  <div className="w-8 h-8 rounded-full bg-purple-600/20 border border-purple-600/40 flex items-center justify-center">
                    <User className="w-5 h-5 text-purple-400" />
                  </div>
                ) : (
                  // Clerk UserButton when auth is enabled
                  user && (
                    <UserButton
                      appearance={{
                        elements: {
                          avatarBox: 'w-8 h-8',
                        },
                      }}
                    />
                  )
                )}
              </span>
              {/* Expanding label column */}
              <span
                className={`text-sm overflow-hidden whitespace-nowrap transition-all duration-200 ${
                  isOpen
                    ? 'opacity-100 max-w-[160px] pr-3'
                    : 'opacity-0 max-w-0'
                }`}
              >
                {user?.emailAddresses?.[0]?.emailAddress || 'Profile'}
              </span>
            </div>
          </SignedIn>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;
