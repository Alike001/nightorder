# NightOrder business model assumptions and cfo.ai evidence

**Status:** The NightOrder cfo.ai model is publicly viewable at [cfo.ai/s/HW7EXJ-uQPEYOLdM](https://cfo.ai/s/HW7EXJ-uQPEYOLdM). The project includes the Assumptions, Operating Model, Financial Model, and Decision Dashboard exports. This document preserves the model inputs and limitations for review; it is not itself one of those exports. The public link and exports do not establish customer traction or validated forecasts.

**Model date:** 2026-10-10 · **Currency:** USD · **Product:** subscription software for human-approved BTCUSDT paper-order monitoring and evidence. No funded trading, execution fees, returns, or trading profits are modeled.

## Submitted cfo.ai scenario

The public cfo.ai model is the current submission model. Its 12-month planning horizon is October 2026 through September 2027, with $19 Individual and $49 Pro tiers. All inputs and outputs are hypothetical: NightOrder has no paying customers or operating history.

Current model controls shown in the public export include **$25,000 illustrative starting cash**, **$4,000/month founder compensation**, **$300/month fixed service infrastructure**, **$750/month reliability and security**, **$250/month administration**, and **$1,500/month marketing**. These replace the simpler cost and cash assumptions in the preliminary repository scenario below for submission planning.

| Exported scenario | 12-month revenue | Operating profit | Gross margin | Month-12 customers | Month-12 MRR | Month-12 cash | Lowest cash | Operating break-even |
| ----------------- | ---------------: | ---------------: | -----------: | -----------------: | -----------: | ------------: | ----------: | -------------------- |
| Main              |       $83,307.22 |      -$18,594.36 |        71.3% |            484.108 |   $13,083.89 |     $6,405.64 |      $85.87 | June 2027            |
| Conservative      |       $40,891.28 |      -$55,677.64 |        54.6% |            231.428 |    $6,202.26 |   -$30,677.64 | -$30,677.64 | Not in horizon       |
| Optimistic        |      $141,842.77 |       $27,824.71 |        74.6% |            839.559 |   $22,768.92 |    $52,824.71 |  $10,798.77 | February 2027        |

In the main scenario, the export shows a February 2027 reserve breach, no cash-exhaustion crossing within the horizon, and June 2027 operating break-even. The conservative scenario crosses cash exhaustion in February 2027. These outputs are scenario calculations, not commitments, actual revenue, or evidence of traction.

## Preliminary repository scenario (superseded for submission planning)

The calculations below preserve the October 10 preliminary sensitivity model that existed before the cfo.ai project was built. They use $10,000 opening cash, unpaid founders, a simplified $37.66 monthly infrastructure estimate, and a separate assumed cfo.ai subscription outflow. They are retained for provenance and must not be combined with, or presented as, the current exported cfo.ai scenario above.

## Executive case

Test a low-cost subscription for a small group of self-directed traders who want an approved paper instruction monitored while they are offline, with a durable order journal and evidence-backed status. The first year is a validation exercise. Prices, conversion, retention, support burden, and willingness to pay are hypotheses; none have been validated with customers. This eventual multi-customer SaaS thesis is beyond the current P0 prototype's one-owner scope and would require separate product, security, and legal review before launch.

Proposed monthly tiers:

| Tier    | Price | Assumed mix | Scope hypothesis                                |
| ------- | ----: | ----------: | ----------------------------------------------- |
| Starter |   $19 |         80% | One account, paper BTCUSDT plans, basic history |
| Pro     |   $49 |         20% | Longer history and richer diagnostics/evidence  |

This implies a blended monthly subscription revenue of **$25 per paid account**. Both tiers remain paper-only. The product must not imply likely fills or returns.

## Cost assumptions

These are planning inputs, not measured production bills. Re-price before a real launch.

| Input                             |        Base assumption | Calculation / source                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker compute                    |           $15.26/month | One Linux EC2 `t3.small` at $0.0209/hour × 730 hours. The AWS instance page lists the hourly price; confirm the exact account quote and `us-east-1` rate in AWS Pricing Calculator.                                                                                 |
| Persistent disk                   |            $2.40/month | 30 GB gp3 × $0.08/GB-month; baseline IOPS/throughput only.                                                                                                                                                                                                          |
| Logs, backups, monitoring reserve |              $20/month | Internal estimate; no vendor quote or production usage measurement yet.                                                                                                                                                                                             |
| Shared hosting + operations       |           $37.66/month | $15.26 compute + $2.40 disk + $20 reserve. One instance shared by the modeled accounts; no high availability.                                                                                                                                                       |
| Model usage per recovery          |                 $0.026 | Costing proxy: 8,000 input tokens and 1,000 output tokens at $2/$10 per million, respectively. Uses the published standard rate for `gpt-6.1-sol` as a conservative reference; the app model is configured by environment and has not been selected or live-costed. |
| Model usage per account           |            $0.52/month | 20 recovery incidents × $0.026 each. Ordinary quote polling is deterministic and does not call the model.                                                                                                                                                           |
| Payment processing                | $1.025 per $25 payment | U.S. domestic card proxy: 2.9% × $25 + $0.30. Payment provider and merchant jurisdiction are not selected. International card/currency fees, taxes, refunds, disputes, and subscription billing fees are excluded.                                                  |
| Customer acquisition              |             $500/month | 10 new paid accounts × $50 assumed CAC. Hypothesis only; no campaign has run.                                                                                                                                                                                       |
| Team labor                        |       $0 in this model | Founders are assumed unpaid during the prototype. This understates commercial operating costs and makes the forecast unsuitable as an investment forecast.                                                                                                          |

The EC2 and EBS amounts use current public AWS pricing references; the model and payment amounts use current vendor pages. Links: [AWS T3 pricing](https://aws.amazon.com/ec2/instance-types/t3/), [AWS gp3 price reference](https://docs.aws.amazon.com/emr/latest/ManagementGuide/emr-plan-storage-compare-volume-types.html), [OpenAI API pricing](https://platform.openai.com/pricing/), and [Stripe U.S. card pricing](https://stripe.com/pricing). Prices and eligibility can vary by region, account, model, and payment method.

## Unit economics at 100 paid accounts

Assuming an 80/20 tier mix:

- Monthly recurring revenue: 100 × $25 = **$2,500**.
- Payment processing: 100 × $1.025 = **$102.50**.
- Model usage: 100 × $0.52 = **$52.00**.
- Shared hosting and operations reserve: **$37.66** total, or $0.377 per account at this volume.
- Estimated direct costs: **$192.16/month**, or **$1.92/account**.
- Estimated gross profit: $2,500 − $192.16 = **$2,307.84/month**.
- Estimated gross margin: $2,307.84 ÷ $2,500 = **92.3%**.

This margin excludes founder labor, customer support staffing, legal/compliance review, taxes, refunds, chargebacks, international processing, and any vendor costs above the $20 operations reserve. Those omissions are material.

## 12-month base case

This is the formula-driven hypothetical base case used as planning input, not actuals:

- Opening cash: **$10,000**, assumed team capital; not confirmed funding.
- Paid acquisition: **10 new paid accounts/month** at a $50 CAC, spending $500/month.
- Monthly churn: **5%** of the active paid base.
- Ending active accounts: prior month × 95% + 10 new accounts.
- Blended subscription revenue: **$25 per active account-month**.
- Direct cost per account-month: $1.025 payment + $0.52 model + $37.66 shared costs ÷ active accounts. Forecast below uses the equivalent formula, shared costs as $37.66/month.
- Founder payroll, tax, compliance, refunds, and expansion infrastructure are excluded.
- cfo.ai Startup list price is **$375/month billed annually** ($4,500 annual commitment) after its advertised 14-day trial. Include $4,500 as an upfront planning-tool outflow until sponsor credits are confirmed. The trial and a credit card may have billing conditions; do not treat credits as cash until verified.

| Month | Ending paid accounts |   Revenue | Direct costs | Acquisition spend | Ending cash after $4,500 cfo.ai annual payment |
| ----: | -------------------: | --------: | -----------: | ----------------: | ---------------------------------------------: |
|     1 |                 10.0 |   $250.00 |       $53.11 |              $500 |                                      $5,196.89 |
|     2 |                 19.5 |   $487.50 |       $67.79 |              $500 |                                      $5,116.60 |
|     3 |                 28.5 |   $713.13 |       $81.73 |              $500 |                                      $5,248.00 |
|     4 |                 37.1 |   $927.47 |       $94.98 |              $500 |                                      $5,580.49 |
|     5 |                 45.2 | $1,131.10 |      $107.56 |              $500 |                                      $6,104.02 |
|     6 |                 53.0 | $1,324.54 |      $119.52 |              $500 |                                      $6,809.05 |
|     7 |                 60.3 | $1,508.31 |      $130.87 |              $500 |                                      $7,686.48 |
|     8 |                 67.3 | $1,682.90 |      $141.66 |              $500 |                                      $8,727.72 |
|     9 |                 74.0 | $1,848.75 |      $151.91 |              $500 |                                      $9,924.56 |
|    10 |                 80.3 | $2,006.32 |      $161.65 |              $500 |                                     $11,269.22 |
|    11 |                 86.2 | $2,156.00 |      $170.90 |              $500 |                                     $12,754.32 |
|    12 |                 91.9 | $2,298.20 |      $179.69 |              $500 |                                     $14,372.83 |

The 12-month result is about **$16,334 revenue** and **$14,373 ending cash**, after the assumed $4,500 cfo.ai annual payment. Without that payment, the arithmetic ending cash would be $18,873. Neither figure is a commitment or a forecast backed by customer data.

At zero revenue, modeled monthly cash outflow is $500 acquisition + $37.66 hosting/operations = $537.66. After the $4,500 annual cfo.ai payment, $5,500 of assumed opening cash remains, implying **10.2 months of zero-revenue runway**. If the cfo.ai cost is fully covered by verified credits, the same zero-revenue runway is **18.6 months**. These simple runway figures exclude taxes, payroll, unexpected infrastructure, and other obligations.

## Sensitivity and decision gates

- At 100 recovery incidents per account/month, model cost rises from $0.52 to **$2.60/account/month** under the same token assumptions. Re-run with measured input/output usage before pricing.
- If average revenue is only $19, payment fees fall slightly, producing roughly **90.8% gross margin** under the same recovery and shared-cost assumptions, before omitted expenses.
- At the base $25 ARPU and unit direct cost near $1.92, approximately **22 active accounts** cover the $500 monthly acquisition budget. This is not full-company break-even because team labor and compliance are omitted.
- Stop or reprice if measured CAC, churn, model usage, or customer support materially exceeds these assumptions. Do not use cfo.ai or the model as a live-order risk oracle.

## cfo.ai model and exports

The actual NightOrder cfo.ai project is publicly viewable at [cfo.ai/s/HW7EXJ-uQPEYOLdM](https://cfo.ai/s/HW7EXJ-uQPEYOLdM), with **Assumptions**, **Operating Model**, **Financial Model**, and **Decision Dashboard** exports. Use the public project to inspect its scenario analysis and runway. The exported files are maintained with the cfo.ai project and are not checked into this repository.

The figures above remain **hypothetical assumptions**, not company actuals: NightOrder has no paying customers, and opening cash, acquisition, churn, pricing mix, costs, and forecast outputs have not been validated by operating history. The model is for business planning only, not a live-order risk oracle or investment advice. cfo.ai access, credits, and billing status are not asserted by this evidence note.

Source: [cfo.ai pricing and trial](https://cfo.ai/pricing).
