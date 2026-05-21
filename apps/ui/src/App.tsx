import { Routes, Route, Navigate } from 'react-router-dom';
import { Suspense, lazy } from 'react';

const Dashboard = lazy(() => import('./pages/Dashboard.tsx'));
const Import = lazy(() => import('./pages/repos/Import.tsx'));
const AllRepos = lazy(() => import('./pages/repos/AllRepos.tsx'));
const ScanQueue = lazy(() => import('./pages/scans/Queue.tsx'));
const ScanHistory = lazy(() => import('./pages/scans/History.tsx'));
const Confirmed = lazy(() => import('./pages/vulnerabilities/Confirmed.tsx'));
const Dropped = lazy(() => import('./pages/vulnerabilities/Dropped.tsx'));
const Exploits = lazy(() => import('./pages/Exploits.tsx'));
const Workers = lazy(() => import('./pages/Workers.tsx'));
const Settings = lazy(() => import('./pages/Settings.tsx'));

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/repos/import" element={<Import />} />
        <Route path="/repos" element={<AllRepos />} />
        <Route path="/scans/queue" element={<ScanQueue />} />
        <Route path="/scans/history" element={<ScanHistory />} />
        <Route path="/vulns/confirmed" element={<Confirmed />} />
        <Route path="/vulns/dropped" element={<Dropped />} />
        <Route path="/exploits" element={<Exploits />} />
        <Route path="/workers" element={<Workers />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
