# The Wedge

> Captured verbatim from the owner, 2026-09-21. Governing strategy doc — see `plan/phase-wedge.md` for the execution plan derived from it.

## First: what a wedge actually is

A wedge is not your product. It's the smallest thing that gets a specific person to adopt, which then pulls the rest of the platform behind it.

- WordPress's wedge was blogging. Not "a CMS." Blogging. One specific job, done in 5 minutes.
- Stripe's wedge was 7 lines of code to accept a payment.
- Slack's wedge was replacing IRC for one team.
- Notion's wedge was docs, then wikis, then everything.

The wedge is always narrower than the founder wants it to be. The temptation is to say "the wedge is the company OS." That's not a wedge. That's the whole thing.

## The obvious wedges are traps

Website builder? Crowded. OSW, nopen, TheLux, Nordcraft, Next Site Method, plus Wix, Squarespace, Framer, Webflow. You will not out-market them. And it positions you as "another website tool," which is the opposite of what you are.

Web shop? Same problem. Shopify, WooCommerce, BigCommerce, Snipcart. Crowded, and the buyer expects a shop, not an OS.

Company memory (Eigen Mesh)? Abstract. Nobody wakes up wanting "a memory layer." They want their company to work.

Email (Owlery)? Same. Nobody adopts a company OS because of email.

These are all modules, not wedges. Selling a module as the entry point reduces you to competing with the incumbent in that module's category. You lose that fight.

## The actual wedge

Here's my read:

> The wedge is the moment: "I described my company in a conversation, and 10 minutes later it was running on my own VPS."

That's the WordPress 5-minute-install moment. That's the thing no competitor has. Not Cloudflare OS (too enterprise, too Cloudflare-native). Not Paperclip (agent orchestration, no company substrate). Not ERPNext (the opposite experience). Not Wix (no ownership, no agent, no OS).

The wedge is the install + first conversation. The feeling of: *I own this, it's mine, and it built itself.*

## What the first module has to be

If the wedge is the install experience, the first module has to deliver on the promise. It has to be:

1. Universally needed — every company needs it
2. Painfully served today — the status quo is bad
3. Demonstrative of the module system — it proves modules work
4. A pull toward other modules — using it makes you want the next one
5. Winnable — you can be meaningfully better than incumbents

I think the answer is the website — but not as "website builder."

As: **"the public face of your company, generated from your brand, your memory, and your modules — and updated by conversation."**

The differentiation from Wix/Squarespace/Framer isn't the editor. It's that the website isn't separate from the company. It's a rendering of the company's state.

- Update brand guidelines via the agent → the website updates.
- Add a product via the shop module → it appears on the website.
- Change tone of voice in Eigen Mesh → the copy regenerates.
- Add a new page → the agent writes it, in your voice, using your actual content.

No competitor does this because no competitor has the company as a substrate. Wix has a website. You have a company that *renders* a website.

## The flywheel

The step-by-step loop:

1. Solo founder deploys company OS to launch their website
2. Realizes the website is one module on a running OS
3. Adds the shop (because the OS already knows the products)
4. Adds email (because Owlery is already there)
5. Adds memory (because Eigen Mesh already remembers the brand)
6. Now their entire company runs on it
7. Tells other founders
8. Module devs see a market and start shipping

Each step is trivial because the substrate is already there. That's the pull. That's the flywheel.

## What has to be true for this to work

1. **Deploy is one command.** `curl | sh`, `docker compose up`, whatever — but under 10 minutes, no config files, no decisions.
2. **The first conversation is magical.** The agent asks the right questions, and the output is genuinely good. Not "AI-generated website" good. "I would ship this" good.
3. **Adding a second module is trivial.** If module #2 takes more than 2 minutes, the flywheel breaks.
4. **The module manifest is dead simple.** A solo dev ships a module in a weekend. If it takes a week, you get no ecosystem.
5. **You have company templates.** "Here's a pre-configured solo consultancy." "Here's a pre-configured e-commerce brand." One-click. This is the WordPress themes equivalent, and it's what makes non-technical people adopt.
6. **There's a reason for module devs to build.** Freemium, licensing, marketplace, whatever — but if module devs can't eat, you get no modules, and you're just another framework.

## The one-sentence pitch

> "Describe your company. Get a company OS on your own server in 10 minutes. Own everything. Extend it with git."

That's the wedge. Everything else — the module system, the shell, Eigen Mesh, Owlery, the operator/user-agent split — is the machinery that makes the promise real.

## What to build first

Not the full architecture. The thin slice:

1. Agent harness (minimal tool registry)
2. One module: website (generated from conversation, stored as git, rendered by SvelteKit)
3. One-command deploy to a VPS
4. Eigen Mesh wired in from day one (so the website remembers)
5. Owlery wired in from day one (so the contact form works)

That's it. No shop. No brand module. No design system. No org charts.

If that slice feels magical, the rest follows. If it doesn't, no amount of architecture saves it.

## The honest risk

The wedge assumes the agent is good enough to generate a website a founder would actually ship. That's the hard part. The architecture is solvable. The module system is solvable. The deploy is solvable.

**The agent's output quality is the thing that decides this.**

If the first website it generates is embarrassing, the flywheel never starts. If it's genuinely good — in the founder's voice, with their real content, looking like something they'd pay for — the flywheel starts, and everything else compounds.

That's the bet within the bet. The architecture serves it. The wedge tests it.

---

## Open threads to go deeper on

- The website module spec — what it actually generates, from what inputs
- The template system — company templates as the WordPress themes equivalent
- The module dev economics — how module devs make money
- The first conversation — the exact flow the agent runs on day one
