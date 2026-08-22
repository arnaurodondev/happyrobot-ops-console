import Link from "next/link";

export default function NotFound() {
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-head">
          <div className="brand-mark">
            <span className="brand-dot" aria-hidden="true" />
            <span>Carrier Sales Ops Console</span>
          </div>
          <p>That page does not exist in this console.</p>
        </div>
        <div className="login-body">
          <Link className="btn primary" href="/">
            Back to the overview
          </Link>
        </div>
      </div>
    </main>
  );
}
