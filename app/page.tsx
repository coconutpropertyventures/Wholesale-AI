import Header from "@/components/Header";
import PipelineStrip from "@/components/PipelineStrip";
import Inbox from "@/components/Inbox";
import DealPanel from "@/components/DealPanel";
import DraftsPanel from "@/components/DraftsPanel";
import BuyersPanel from "@/components/BuyersPanel";
import AiCommand from "@/components/AiCommand";

/**
 * Wholesale AI — single-screen command center (milestone 1).
 * Left: unified inbox. Center: property intake, underwriting, offer draft,
 * and the approval queue. Right: AI command + buyer book.
 */
export default function HomePage() {
  return (
    <>
      <Header />
      <main className="shell">
        <PipelineStrip />
        <div className="grid">
          <div className="col">
            <Inbox />
          </div>
          <div className="col">
            <DealPanel />
            <DraftsPanel />
          </div>
          <div className="col">
            <AiCommand />
            <BuyersPanel />
          </div>
        </div>
      </main>
    </>
  );
}
