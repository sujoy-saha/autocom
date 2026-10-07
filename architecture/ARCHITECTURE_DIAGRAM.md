# AutoCom — Architecture Diagram (Slide 5 source)

This is a [Mermaid](https://mermaid.js.org/) diagram — GitHub, VS Code (Markdown Preview Mermaid Support
extension), and Notion render it natively. To export a PNG/SVG for a slide deck:

1. Paste the code block below into **https://mermaid.live** → "Actions" → "Export as PNG/SVG", or
2. `npm install -g @mermaid-js/mermaid-cli` then:
   ```
   mmdc -i ARCHITECTURE_DIAGRAM.md -o architecture.png -b transparent -s 3
   ```
   (mmdc reads the first ```mermaid fenced block in a markdown file)

> **Note:** `architecture-simple.png`, `architecture-personas.png`, and
> `architecture-detailed.png` in this folder are rendered from the diagrams
> below (including the persona/agentic-commerce-mesh update) via
> `@mermaid-js/mermaid-cli` (`mmdc -i <file>.mmd -o <file>.png -b transparent
> -s 3`). Regenerate them the same way if you edit the diagrams further.

---

## Full pipeline + guardrail + vendor restock + audit trail

```mermaid
flowchart TB
    PDF["📄 Uploaded PO PDF<br/>(from partner email)"]

    subgraph Pipeline["LangGraph multi-agent pipeline"]
        direction TB
        Intake["🔎 PO Intake Agent<br/>Nemotron + MCP tool-calling<br/>extracts vendor, items, addresses"]
        Inventory["📦 Inventory Agent<br/>reserves stock atomically<br/>auto-provisions unknown SKUs"]
        Replenishment["🔁 Replenishment Agent<br/>on shortfall: Nemotron negotiates a<br/>restock order with the vendor's system"]
        Approval["🛑 Approval Agent<br/>guardrail: holds orders over<br/>APPROVAL_THRESHOLD for human sign-off"]
        Payment["💳 Payment Agent<br/>Stripe test-mode (sandbox) charge<br/>— sim. fallback if no Stripe key"]
        Fulfillment["🚚 Fulfillment Agent<br/>DSV sandbox Road booking<br/>— sim. fallback if no DSV creds"]
        Support["✉️ Support Agent<br/>Nemotron drafts customer notification<br/>for every outcome"]
    end

    Human["🧑‍💼 Human reviewer<br/>Approve / Reject in dashboard"]
    DB[("🗄️ Supabase<br/>orders · payments · shipments ·<br/>notifications · agent_logs")]
    Dashboard["📊 Live dashboard<br/>Next.js + Supabase Realtime"]
    MCP["🔧 Our MCP Server<br/>list_inventory · check_inventory ·<br/>ensure_inventory_item · get_order_status · place_order"]
    Nebius["🧠 Nebius Token Factory<br/>NVIDIA Nemotron"]

    subgraph VendorSystem["External vendor/supplier (separate system)"]
        direction TB
        VendorMCP["🏭 Vendor MCP Server<br/>get_vendor_catalog · check_vendor_stock ·<br/>propose/finalize_restock_order · get_vendor_order_status"]
        VendorStock[("📦 Vendor's own stock &<br/>pricing — no shared DB")]
        VendorMCP <-.-> VendorStock
    end

    subgraph SupplierMesh["Agentic commerce mesh: restock → invoice → payment"]
        direction TB
        SupplierAgent["🏷️ Supplier Agent<br/>registers the restock request,<br/>waits for human Supplier decision"]
        HumanSupplier["🧑‍🔧 Human Supplier<br/>Approve / Reject on /supplier"]
        SupplierInvoiceAgent["🧾 Supplier Invoice Agent<br/>auto-generates + sends invoice<br/>on Supplier approval"]
        InvoiceValidator["✅ Invoice Validator Agent<br/>cross-checks invoice vs.<br/>restock order, flags mismatches"]
        HumanSeller["🧑‍💼 Human Seller<br/>Approve / Reject on /invoices"]
    end

    PDF --> Intake
    Intake -- "backordered SKU?" --> Support
    Intake --> Inventory
    Inventory -- "reserved OK" --> Approval
    Inventory -- "out of stock" --> Replenishment
    Replenishment --> Support
    Approval -- "over threshold" --> Human
    Human -- "Approve" --> Payment
    Human -- "Reject" --> Support
    Approval -- "under threshold (auto)" --> Payment
    Payment -- "declined" --> Support
    Payment -- "succeeded" --> Fulfillment
    Fulfillment --> Support

    Intake <-.-> MCP
    MCP <-.-> Nebius
    Replenishment <-.->|"agent-to-agent MCP<br/>negotiation"| VendorMCP

    Replenishment -- "persists restock_orders row" --> SupplierAgent
    SupplierAgent -- "awaiting decision" --> HumanSupplier
    HumanSupplier -- "Approve" --> SupplierInvoiceAgent
    HumanSupplier -- "Reject" --> Support
    SupplierInvoiceAgent --> InvoiceValidator
    InvoiceValidator -- "validated / flagged" --> HumanSeller
    HumanSeller -- "Approve (charges Stripe)" --> Inventory
    HumanSeller -- "Reject" --> Support

    Intake -.->|"log every step"| DB
    Inventory -.->|"log every step"| DB
    Replenishment -.->|"log every step"| DB
    Approval -.->|"log every step"| DB
    Payment -.->|"log every step"| DB
    Fulfillment -.->|"log every step"| DB
    Support -.->|"log every step"| DB
    SupplierAgent -.->|"log every step"| DB
    SupplierInvoiceAgent -.->|"log every step"| DB
    InvoiceValidator -.->|"log every step"| DB
    HumanSeller -.->|"log every step"| DB

    DB -- "Realtime" --> Dashboard

    style Approval fill:#fff3cd,stroke:#997404,stroke-width:2px
    style Human fill:#fff3cd,stroke:#997404,stroke-width:2px
    style HumanSupplier fill:#fff3cd,stroke:#997404,stroke-width:2px
    style HumanSeller fill:#fff3cd,stroke:#997404,stroke-width:2px
    style Replenishment fill:#ffe0cc,stroke:#b35900,stroke-width:2px
    style VendorSystem fill:#f5e6ff,stroke:#6a1b9a,stroke-width:2px
    style VendorMCP fill:#e6ccff,stroke:#6a1b9a,stroke-width:2px
    style SupplierMesh fill:#e6f7ff,stroke:#0369a1,stroke-width:2px
    style SupplierAgent fill:#cceeff,stroke:#0369a1,stroke-width:2px
    style SupplierInvoiceAgent fill:#cceeff,stroke:#0369a1,stroke-width:2px
    style InvoiceValidator fill:#cceeff,stroke:#0369a1,stroke-width:2px
    style Nebius fill:#d1f0d1,stroke:#2d6a2d,stroke-width:2px
    style MCP fill:#d1e7ff,stroke:#0353a4,stroke-width:2px
```

---

## Persona access model: Buyer / Seller / Supplier

Every screen and API route is gated server-side by a `profiles.role` lookup
(`requireRole` middleware) — the frontend nav/redirects are UX convenience,
not the security boundary.

```mermaid
flowchart LR
    Buyer["🛒 Buyer<br/>places POs, views status<br/>read-only — no Inventory,<br/>no Approve/Reject/Retry"]
    Seller["🧑‍💼 Seller<br/>full pipeline access:<br/>Approve/Reject/Retry, Inventory,<br/>+ reviews Supplier invoices"]
    Supplier["🏷️ Supplier<br/>sees only its own<br/>restock requests + invoices<br/>on /supplier"]

    Dashboard["📊 /dashboard, /inventory"]
    SupplierPage["📦 /supplier"]
    InvoicesPage["🧾 /invoices"]

    Buyer -- "read-only" --> Dashboard
    Seller -- "full access" --> Dashboard
    Seller -- "review/approve" --> InvoicesPage
    Supplier -- "approve/reject +<br/>invoice status" --> SupplierPage

    style Buyer fill:#e0f2fe,stroke:#0369a1,stroke-width:2px
    style Seller fill:#dcfce7,stroke:#15803d,stroke-width:2px
    style Supplier fill:#fef3c7,stroke:#b45309,stroke-width:2px
```

---

## Simplified version (if the full diagram is too dense for a slide)

```mermaid
flowchart LR
    A["📄 Partner PO"] --> B["PO Intake"]
    B --> C["Inventory"]
    C -- "in stock" --> D{"Over<br/>threshold?"}
    C -- "short" --> R["🔁 Replenishment<br/>(negotiates via vendor MCP)"]
    R --> H2["✉️ Notify<br/>(backordered)"]
    R --> R2["🏷️ Supplier Agent<br/>(waits for Supplier)"]
    R2 --> R3["🧑‍🔧 Supplier approves"]
    R3 --> R4["🧾 Supplier Invoice Agent<br/>+ ✅ Invoice Validator"]
    R4 --> R5["🧑‍💼 Seller approves<br/>(pays + restocks inventory)"]
    D -- yes --> E["🧑‍💼 Human<br/>Approve/Reject"]
    D -- no --> F["Payment"]
    E -- approved --> F
    F --> G["Fulfillment"]
    G --> H["✉️ Customer<br/>notification"]

    style D fill:#fff3cd,stroke:#997404,stroke-width:2px
    style E fill:#fff3cd,stroke:#997404,stroke-width:2px
    style R fill:#ffe0cc,stroke:#b35900,stroke-width:2px
    style R2 fill:#cceeff,stroke:#0369a1,stroke-width:2px
    style R3 fill:#fff3cd,stroke:#997404,stroke-width:2px
    style R4 fill:#cceeff,stroke:#0369a1,stroke-width:2px
    style R5 fill:#fff3cd,stroke:#997404,stroke-width:2px
```
