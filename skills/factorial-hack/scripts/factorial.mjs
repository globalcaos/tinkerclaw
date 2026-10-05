#!/usr/bin/env node
/**
 * factorial.mjs — Factorial HR GraphQL proxy via Chrome browser relay
 *
 * Factorial uses httpOnly cookies — tokens can't be extracted.
 * This skill runs GraphQL queries through the attached Chrome tab.
 * Requires: Factorial tab attached via OpenClaw browser relay.
 *
 * Architecture:
 *   Agent calls this script → script outputs GraphQL query → agent runs it via browser evaluate
 *   OR: agent uses the query library directly via browser evaluate
 *
 * This file serves as a QUERY LIBRARY + CLI reference.
 * The actual execution happens through browser(action=act, evaluate) calls.
 *
 * Subcommands (output GraphQL queries for the agent to execute):
 *   employees [--active] [--search X] [--top N]
 *   employee <id>
 *   teams
 *   calendar [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   timeoff [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--employee-id N]
 *   attendance [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--employee-id N]
 *   shifts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--employee-id N]
 *   leaves [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--employee-id N]
 *   company
 *   query <raw-graphql>
 */

// ─── Query Library ───
// These are the tested, working queries for Factorial's GraphQL API.

const QUERIES = {
  employees: (opts = {}) => {
    const top = opts.top || 100;
    const active = opts.active !== false;
    const search = opts.search ? `, fullTextName: "${opts.search}"` : "";
    return `{
      employees {
        employeesConnection(first: ${top}, onlyActive: ${active}${search}) {
          nodes {
            id fullName email firstName lastName
            active birthdayOn city country
            phoneNumber personalEmail
            manager { id fullName }
            memberships { nodes { id teamId lead } }
            legalEntity { id country }
            locationName
            terminatedOn
          }
          pageInfo { hasNextPage endCursor }
          totalCount
        }
      }
    }`;
  },

  employee: (id) => `{
    employees {
      employee(id: ${id}) {
        id fullName email firstName lastName
        active birthdayOn city country state postalCode
        addressLine1 addressLine2
        phoneNumber personalEmail
        nationality gender { id name }
        identifier identifierType
        socialSecurityNumber taxId
        bankNumber swiftBic
        manager { id fullName }
        timeoffManager { id fullName }
        memberships { nodes { id teamId lead } }
        legalEntity { id country }
        locationName
        seniorityCalculationDate
        terminatedOn terminationReason terminationType
        createdAt updatedAt
      }
    }
  }`,

  employeeNames: (opts = {}) => {
    const top = opts.top || 200;
    const search = opts.search ? `, search: "${opts.search}"` : "";
    return `{
      employees {
        employeeNamesConnection(first: ${top}, onlyActive: true${search}) {
          nodes { id fullName }
        }
      }
    }`;
  },

  teams: () => `{
    teams {
      teamsConnection(first: 50) {
        nodes {
          id name description
          membershipsConnection(first: 100) {
            nodes { id lead employee { id fullName } }
          }
        }
      }
    }
  }`,

  calendar: (opts = {}) => {
    const from = opts.from || new Date().toISOString().slice(0, 10);
    const to = opts.to || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    return `{
      calendar {
        calendarEventsConnection(first: 100, startsOn: "${from}", endsOn: "${to}") {
          nodes {
            id date description
            employee { id fullName }
            halfDay startHalf endHalf
            leaveType { id name color accruesOnPayslip visibility }
          }
        }
      }
    }`;
  },

  leaves: (opts = {}) => {
    const from = opts.from || new Date().toISOString().slice(0, 10);
    const to = opts.to || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const empFilter = opts.employeeId ? `, employeeId: ${opts.employeeId}` : "";
    return `{
      timeoff {
        leavesConnection(first: 100, overlapsRangeFrom: "${from}", overlapsRangeTo: "${to}"${empFilter}, onlyActive: true) {
          nodes {
            id description startOn finishOn halfDay
            approved
            employee { id fullName }
            leaveType { id name }
          }
        }
      }
    }`;
  },

  upcomingLeaves: (opts = {}) => {
    const days = opts.days || 14;
    return `{
      timeoff {
        upcomingLeavesConnection(first: 50, futureDays: ${days}) {
          nodes {
            id startOn finishOn halfDay
            employee { id fullName }
            leaveType { id name }
          }
        }
      }
    }`;
  },

  shifts: (opts = {}) => {
    const from = opts.from || new Date().toISOString().slice(0, 10);
    const to = opts.to || from;
    const empFilter = opts.employeeIds ? `, employeeIds: [${opts.employeeIds}]` : "";
    return `{
      attendance {
        shiftsConnection(first: 100, startOn: "${from}", endOn: "${to}"${empFilter}) {
          nodes {
            id date clockIn clockOut
            observations
            employee { id fullName }
          }
        }
      }
    }`;
  },

  workedTime: (opts = {}) => {
    const from = opts.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = opts.to || new Date().toISOString().slice(0, 10);
    const empFilter = opts.employeeIds ? `, employeeIds: [${opts.employeeIds}]` : "";
    return `{
      attendance {
        workedTimesConnection(first: 100, startOn: "${from}", endOn: "${to}"${empFilter}) {
          nodes {
            id date workedSeconds
            employee { id fullName }
          }
        }
      }
    }`;
  },

  company: () => `{
    companies {
      companiesConnection(first: 10) {
        nodes {
          id name
          legalEntitiesConnection(first: 20) {
            nodes { id name country }
          }
        }
      }
    }
  }`,

  leaveTypes: () => `{
    timeoff {
      leaveTypesConnection(first: 50, active: true) {
        nodes {
          id name color accruesOnPayslip visibility
        }
      }
    }
  }`,
};

// ─── CLI ───
function parseArgs(argv) {
  const result = { _: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        result.flags[key] = argv[++i];
      } else {
        result.flags[key] = true;
      }
    } else {
      result._.push(argv[i]);
    }
    i++;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = args._;

function outputQuery(query) {
  // Clean up whitespace for readability
  const cleaned = query.replace(/\s+/g, " ").trim();
  console.log(JSON.stringify({ query: cleaned }));
}

switch (cmd) {
  case "employees":
    outputQuery(
      QUERIES.employees({
        top: parseInt(args.flags.top) || 100,
        active: !args.flags["include-inactive"],
        search: args.flags.search,
      }),
    );
    break;

  case "employee":
    if (!rest[0]) {
      console.error("Usage: factorial employee <id>");
      process.exit(1);
    }
    outputQuery(QUERIES.employee(rest[0]));
    break;

  case "names":
    outputQuery(
      QUERIES.employeeNames({ top: parseInt(args.flags.top) || 200, search: args.flags.search }),
    );
    break;

  case "teams":
    outputQuery(QUERIES.teams());
    break;

  case "calendar":
    outputQuery(QUERIES.calendar({ from: args.flags.from, to: args.flags.to }));
    break;

  case "leaves":
    outputQuery(
      QUERIES.leaves({
        from: args.flags.from,
        to: args.flags.to,
        employeeId: args.flags["employee-id"],
      }),
    );
    break;

  case "upcoming":
    outputQuery(QUERIES.upcomingLeaves({ days: parseInt(args.flags.days) || 14 }));
    break;

  case "shifts":
    outputQuery(
      QUERIES.shifts({
        from: args.flags.from,
        to: args.flags.to,
        employeeIds: args.flags["employee-ids"],
      }),
    );
    break;

  case "worked-time":
    outputQuery(
      QUERIES.workedTime({
        from: args.flags.from,
        to: args.flags.to,
        employeeIds: args.flags["employee-ids"],
      }),
    );
    break;

  case "company":
    outputQuery(QUERIES.company());
    break;

  case "leave-types":
    outputQuery(QUERIES.leaveTypes());
    break;

  case "query":
    if (!rest[0]) {
      console.error('Usage: factorial query "<graphql>"');
      process.exit(1);
    }
    outputQuery(rest[0]);
    break;

  default:
    console.log(`factorial — Factorial HR GraphQL query builder

Commands:
  employees [--active] [--search X] [--top N] [--include-inactive]
  employee <id>
  names [--search X] [--top N]
  teams
  calendar [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  leaves [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--employee-id N]
  upcoming [--days 14]
  shifts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--employee-ids 1,2,3]
  worked-time [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--employee-ids 1,2,3]
  company
  leave-types
  query "<raw graphql>"

⚠️  Requires Factorial tab attached via Chrome relay.
    Queries execute through browser evaluate, not HTTP.`);
    break;
}
