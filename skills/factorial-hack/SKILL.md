---
name: factorial-hack
version: 1.0.0
description: "Query Factorial HR through the browser relay. No API keys, no admin consent. Your authenticated Chrome session IS the API."
metadata:
  openclaw:
    emoji: "👥"
    os: ["linux", "darwin"]
    requires:
      capabilities: ["browser"]
    notes:
      security: "This skill executes GraphQL queries through the user's authenticated Factorial browser session via the Chrome relay. No tokens are extracted — queries run inside the page context where httpOnly cookies are automatically included. Read-only by design. No mutations defined."
---

# Factorial Hack

<role>
You query Factorial HR through the user's authenticated Chrome session via the OpenClaw browser relay. No API keys, no admin consent — you run GraphQL queries inside the page context, where httpOnly cookies are automatically included.
</role>

<why_this_matters>
Factorial locks API keys behind admin roles and uses httpOnly cookies that can't be extracted from outside the browser. Running queries inside the page session sidesteps both: the page sends the request, the cookies go with it, and the data comes back. Read-only by design — no mutations are defined.
</why_this_matters>

## How It Works

1. Open `app.factorialhr.com` in Chrome
2. Attach the tab via OpenClaw browser relay (click toolbar button)
3. Agent runs GraphQL queries through `browser(action=act, evaluate)`

No tokens stored. No credentials files. The browser IS the auth.

## Quick Reference

### Employees

```graphql
{
  employees {
    employeesConnection(first: 100, onlyActive: true) {
      nodes {
        id
        fullName
        email
        firstName
        lastName
        active
        manager {
          id
          fullName
        }
        locationName
      }
      totalCount
    }
  }
}
```

### Single Employee (full detail)

```graphql
{
  employees {
    employee(id: 12345) {
      id
      fullName
      email
      firstName
      lastName
      birthdayOn
      city
      country
      phoneNumber
      personalEmail
      nationality
      manager {
        id
        fullName
      }
      legalEntity {
        id
        country
      }
      locationName
      terminatedOn
      seniorityCalculationDate
    }
  }
}
```

### Teams

```graphql
{
  teams {
    teamsConnection(first: 50) {
      nodes {
        id
        name
        membershipsConnection(first: 100) {
          nodes {
            lead
            employee {
              id
              fullName
            }
          }
        }
      }
    }
  }
}
```

### Calendar Events

```graphql
{
  calendar {
    calendarEventsConnection(first: 100, startsOn: "2026-02-01", endsOn: "2026-03-01") {
      nodes {
        id
        date
        description
        employee {
          id
          fullName
        }
        leaveType {
          id
          name
        }
        halfDay
      }
    }
  }
}
```

### Upcoming Leaves

```graphql
{
  timeoff {
    upcomingLeavesConnection(first: 50, futureDays: 14) {
      nodes {
        id
        startOn
        finishOn
        halfDay
        employee {
          id
          fullName
        }
        leaveType {
          id
          name
        }
      }
    }
  }
}
```

### Leaves (date range)

```graphql
{
  timeoff {
    leavesConnection(
      first: 100
      overlapsRangeFrom: "2026-02-01"
      overlapsRangeTo: "2026-03-01"
      onlyActive: true
    ) {
      nodes {
        id
        startOn
        finishOn
        description
        approved
        employee {
          id
          fullName
        }
        leaveType {
          id
          name
        }
      }
    }
  }
}
```

### Shifts / Clock In-Out

```graphql
{
  attendance {
    shiftsConnection(first: 100, startOn: "2026-02-24", endOn: "2026-02-24") {
      nodes {
        id
        date
        clockIn
        clockOut
        observations
        employee {
          id
          fullName
        }
      }
    }
  }
}
```

### Worked Time

```graphql
{
  attendance {
    workedTimesConnection(first: 100, startOn: "2026-02-17", endOn: "2026-02-24") {
      nodes {
        id
        date
        workedSeconds
        employee {
          id
          fullName
        }
      }
    }
  }
}
```

### Company & Legal Entities

```graphql
{
  companies {
    companiesConnection(first: 10) {
      nodes {
        id
        name
        legalEntitiesConnection(first: 20) {
          nodes {
            id
            name
            country
          }
        }
      }
    }
  }
}
```

### Leave Types

```graphql
{
  timeoff {
    leaveTypesConnection(first: 50, active: true) {
      nodes {
        id
        name
        color
        visibility
      }
    }
  }
}
```

## Execution Pattern

The agent executes queries like this:

```javascript
browser(action=act, profile=chrome, targetId=<factorial-tab-id>, request={
  kind: "evaluate",
  fn: `async () => {
    const r = await fetch('https://api.factorialhr.com/graphql', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      credentials: 'include',
      body: JSON.stringify({query: \`<GRAPHQL_QUERY>\`})
    });
    return await r.json();
  }`
})
```

## Query Builder CLI

The `factorial.mjs` script generates query JSON:

```bash
node {baseDir}/scripts/factorial.mjs employees --top 50
node {baseDir}/scripts/factorial.mjs employee 2677400
node {baseDir}/scripts/factorial.mjs calendar --from 2026-02-01 --to 2026-03-01
node {baseDir}/scripts/factorial.mjs leaves --employee-id 2677400
node {baseDir}/scripts/factorial.mjs upcoming --days 7
node {baseDir}/scripts/factorial.mjs teams
node {baseDir}/scripts/factorial.mjs company
```

## Key Employee Fields

| Field           | Type    | Notes                                 |
| --------------- | ------- | ------------------------------------- |
| `id`            | Int     | Unique employee ID                    |
| `fullName`      | String  | "FIRST LAST" (uppercase)              |
| `email`         | String  | Work email (often null for non-admin) |
| `personalEmail` | String  | Personal email                        |
| `phoneNumber`   | String  | Phone                                 |
| `manager`       | Object  | `{ id, fullName }`                    |
| `legalEntity`   | Object  | `{ id, name }` — the legal company    |
| `locationName`  | String  | Office location                       |
| `birthdayOn`    | Date    | Birthday                              |
| `terminatedOn`  | Date    | null if active                        |
| `active`        | Boolean | Employment status                     |

## Limitations

- **Read-only** — no mutations defined (by design)
- **Session-dependent** — requires Factorial tab attached in Chrome
- **No offline mode** — if the tab closes or session expires, re-open and re-attach
- **Rate limits** — Factorial may throttle heavy queries; use pagination (`first`, `after`)
- **Permissions** — you see what your Factorial role allows (the operator has limited non-admin access)

## Architecture

- **Zero tokens stored** — nothing in `~/.openclaw/credentials`
- **Zero external deps** — pure GraphQL over browser context
- **httpOnly bypass** — cookies sent automatically by the browser, not extracted
- **Same-origin** — queries go to `api.factorialhr.com` from `app.factorialhr.com` (allowed by Factorial's CORS)
