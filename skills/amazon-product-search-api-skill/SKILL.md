---
name: amazon-product-search-api-skill
description: >
  Extract structured Amazon product search results via BrowserAct's API.
  Use when the user asks to search Amazon, find best-selling items, monitor
  prices or availability, or build a product catalog from search listings.
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["BROWSERACT_API_KEY"] },
        "primaryEnv": "BROWSERACT_API_KEY",
        "install":
          [
            {
              "id": "uv-brew",
              "kind": "brew",
              "formula": "uv",
              "bins": ["uv"],
              "label": "Install uv (brew)",
            },
          ],
      },
  }
---

# Amazon Product Search Automation Skill

<role>
You extract structured Amazon product search results via BrowserAct's API. Inputs: keywords, brand filter, count, language. Output: structured product data (title, URL, rating, price, availability, etc.).
</role>

<why_this_matters>
The BrowserAct API is preferred over agent-driven browsing here because it bypasses CAPTCHA, geofencing, and rate limits while returning deterministic structured data — which is what the user usually wants when asking for "Amazon search results".
</why_this_matters>

## Features

1. Stable extraction — preset workflows avoid generative hallucinations.
2. CAPTCHA bypass built in.
3. No IP/geofencing restrictions for global access.
4. Faster than agent-driven browser automation.
5. Cheaper than high-token AI solutions.

## API key handling

Before running, check the `BROWSERACT_API_KEY` environment variable.

<bad>If unset, run anyway with a placeholder, or invent a key.</bad>
<good>If unset, ask the user to provide one and stop. Show this message: "Since you have not configured the BrowserAct API Key, please go to the [BrowserAct Console](https://www.browseract.com/reception/integrations) to get your Key and provide it to me in this dialog."</good>

## 🛠️ Input Parameters Detail

When calling the script, the Agent should flexibly configure the following parameters based on user needs:

1. **KeyWords (Search Keywords)**
   - **Type**: `string`
   - **Description**: The keywords the user wants to search for on Amazon.
   - **Example**: `phone`, `wireless earbuds`, `laptop stand`

2. **Brand (Brand Filter)**
   - **Type**: `string`
   - **Description**: Filter products by brand name shown in the listing.
   - **Example**: `Apple`, `Samsung`, `Sony`

3. **Maximum_date (Maximum Products)**
   - **Type**: `number`
   - **Description**: The maximum number of products to extract across paginated search results.
   - **Default**: `50`

4. **language (UI Language)**
   - **Type**: `string`
   - **Description**: UI language for the Amazon browsing session.
   - **Options**: `en`, `de`, `fr`, `it`, `es`, `ja`, `zh-CN`, `zh-TW`
   - **Default**: `en`

## 🚀 Call Method (Recommended)

The Agent should execute the following independent script to achieve "one-line command for results":

```bash
# Example Call
uv run {baseDir}/scripts/amazon_product_search_api.py "Keywords" "Brand" Quantity "language"
```

### ⏳ Running Status Monitoring

Since this task involves automated browser operations, it may take a long time (several minutes). The script will **continuously output status logs with timestamps** while running (e.g., `[14:30:05] Task Status: running`).
**Agent Notes**:

- Keep an eye on the terminal output while waiting for the script to return results.
- As long as the terminal is outputting new status logs, the task is running normally; do not misjudge it as a deadlock or unresponsiveness.
- If the status remains unchanged for a long time or the script stops outputting without returning results, consider triggering a retry mechanism.

## 📊 Output Data Description

After successful execution, the script will parse and print results directly from the API response. Results include:

- `product_title`: Product name
- `product_url`: Detail page URL
- `rating_score`: Average star rating
- `review_count`: Total number of reviews
- `monthly_sales`: Estimated monthly sales (if available)
- `current_price`: Current selling price
- `list_price`: Original list price (if available)
- `delivery_info`: Delivery or fulfillment information
- `shipping_location`: Shipping origin or location
- `is_best_seller`: Whether marked as Best Seller
- `is_available`: Whether available for purchase

## Error handling & retry

When the script errors (network, task failure, etc.):

1. Check the output content:
   - If it contains `"Invalid authorization"`, the API key is invalid or expired. Don't retry. Ask the user to recheck and provide a correct key.
   - Otherwise (output starts with `Error:` or returns empty), retry the script once.

2. Retry limit: only one automatic retry. If the second attempt also fails, stop and report the specific error to the user.

## 🌟 Typical Use Cases

1. **Market Research**: Search for "wireless earbuds" from "Sony" to analyze the current market.
2. **Competitive Monitoring**: Track "Samsung" phone prices and availability on Amazon.
3. **Catalog Discovery**: Gather product titles and URLs for a new product catalog in the "laptop stand" category.
4. **Localized Analysis**: Search Amazon in "ja" (Japanese) to understand products available in the Japan region.
5. **Best Seller Tracking**: Identify products marked as "Best Seller" for a specific brand.
6. **Pricing Intelligence**: Compare `current_price` and `list_price` to monitor discounts.
7. **Sales Trend Estimation**: Use `monthly_sales` data to estimate market demand for certain items.
8. **Shipping Efficiency Study**: Analyze `delivery_info` and `shipping_location` for various brands.
9. **Large-scale Data Extraction**: Collect up to 100 products for a comprehensive dataset.
10. **Product Availability Check**: Verify if specific brand products are currently `is_available` for purchase.
