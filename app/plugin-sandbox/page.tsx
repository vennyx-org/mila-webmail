import { SandboxRuntime } from '@/lib/plugin-sandbox/runtime';

export const dynamic = 'force-static';

export default function PluginSandboxPage() {
  return <SandboxRuntime />;
}
