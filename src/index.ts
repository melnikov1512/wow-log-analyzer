#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { localTool, localAnalysis, responseText } from './local/tools.js';
import { WCLClient } from './wcl/client.js';
import { logger } from './utils/logger.js';
import { getZonesResource } from './resources/zones.js';
import { getKnowledgeResource } from './resources/knowledge.js';
import { getActiveCharacterResource } from './resources/active-character.js';
import { setActiveCharacterSchema, handleSetActiveCharacter } from './tools/set-active-character.js';
import { getCharacterSummarySchema, handleGetCharacterSummary } from './tools/get-character-summary.js';
import { getRecentReportsSchema, handleGetRecentReports } from './tools/get-recent-reports.js';
import { getFightSummarySchema, handleGetFightSummary } from './tools/get-fight-summary.js';
import { getFightDamageSchema, handleGetFightDamage } from './tools/get-fight-damage.js';
import { getFightHealingSchema, handleGetFightHealing } from './tools/get-fight-healing.js';
import { getFightDamageTakenSchema, handleGetFightDamageTaken } from './tools/get-fight-damage-taken.js';
import { getCharacterDeathsSchema, handleGetCharacterDeaths } from './tools/get-character-deaths.js';
import { getCharacterCastsSchema, handleGetCharacterCasts } from './tools/get-character-casts.js';
import { getBuffUptimeSchema, handleGetBuffUptime } from './tools/get-buff-uptime.js';
import { getCombatantInfoSchema, handleGetCombatantInfo } from './tools/get-combatant-info.js';
import { getEncounterRankingsSchema, handleGetEncounterRankings } from './tools/get-encounter-rankings.js';
import { getFightEventsSchema, handleGetFightEvents } from './tools/get-fight-events.js';

// Load .env if available (dev only -- in production, env vars come from MCP client config)
try { (await import('dotenv')).config({path:fileURLToPath(new URL('../.env',import.meta.url))}); } catch {}

const WCL_CLIENT_ID = process.env.WCL_CLIENT_ID;
const WCL_CLIENT_SECRET = process.env.WCL_CLIENT_SECRET;

const wclClient = new WCLClient(WCL_CLIENT_ID ?? '', WCL_CLIENT_SECRET ?? '');

const SERVER_DESCRIPTION = `WCL MCP Server -- Warcraft Logs performance analysis for World of Warcraft.

This server queries the Warcraft Logs (WCL) GraphQL API to provide WoW performance data. It accesses public logs only.

## Tool Categories

**Session Setup:**
- set_active_character: Set the character for this session. Call this first so subsequent tools default to your character.

**Discovery:**
- get_character_summary: Quick overview of a character's WCL presence
- get_recent_reports: List recent reports with fight metadata

**Fight Analysis:**
- get_fight_summary: Composite TL;DR of specific fights (damage, healing, deaths)
- get_fight_damage: DPS/damage breakdown with pre-computed metrics
- get_fight_healing: HPS/healing with overhealing percentage
- get_fight_damage_taken: Survivability analysis -- damage sources per player

**Coaching Analysis (compound tools -- handle multi-report workflows internally):**
- get_character_deaths: Death analysis aggregated across recent fights
- get_character_casts: Ability usage data with per-fight averages

**Deep Dive:**
- get_buff_uptime: Buff/debuff uptime tracking
- get_combatant_info: Player setup (class, spec, details)
- get_encounter_rankings: Parse rankings by encounter or zone
- get_fight_events: Raw combat events for event-level analysis

## Recommended Workflow
1. Call set_active_character with the user's character
2. Use get_recent_reports to find interesting reports/fights
3. Use get_fight_summary for a quick overview
4. Drill into specifics: get_fight_damage, get_fight_healing, get_fight_damage_taken
5. For cross-fight patterns: get_character_deaths, get_character_casts
6. For deep dives: get_buff_uptime, get_combatant_info, get_fight_events
7. For rankings: get_encounter_rankings

## Domain Heuristics
- Deaths cost 5 seconds each on the M+ timer and compound -- reducing deaths is usually more impactful than increasing DPS
- Check damage taken context before concluding a death was unavoidable
- Cast frequency comparison is the most actionable metric for improvement
- The keystoneLevel field on fights indicates M+ runs; kill=true means timed completion

## Known Limitations
- Public logs only (client_credentials auth)
- No automated benchmark comparison yet
- Private logs appear identical to "no logs"`;

const server = new Server(
  {
    name: 'warcraftlogs',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  },
);

// --- Tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    localTool,
    {
      name: 'set_active_character',
      description: 'Set the active character for this session. Validates WCL presence and stores character as default for subsequent tool calls.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Character name' },
          realm: { type: 'string', description: 'Realm name or slug (e.g., "Area 52" or "area-52")' },
          region: { type: 'string', description: 'Region: us, eu, kr, tw (aliases: na, america, europe)' },
        },
        required: ['name', 'realm', 'region'],
      },
    },
    {
      name: 'get_character_summary',
      description: 'Quick overview of a character\'s WCL presence: log count, content types, most recent activity. Defaults to the active character if set.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Character name (defaults to active character)' },
          realm: { type: 'string', description: 'Realm name or slug (defaults to active character)' },
          region: { type: 'string', description: 'Region (defaults to active character)' },
        },
      },
    },
    {
      name: 'get_recent_reports',
      description: 'List a character\'s recent WCL reports with fight-level metadata. Use this to discover report codes and fight IDs for deeper analysis.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Character name (defaults to active character)' },
          realm: { type: 'string', description: 'Realm name or slug (defaults to active character)' },
          region: { type: 'string', description: 'Region (defaults to active character)' },
          limit: { type: 'number', description: 'Number of reports (default 10, max 50)' },
          content_type: { type: 'string', enum: ['raid', 'mythicplus'], description: 'Filter to raid or mythicplus' },
        },
      },
    },
    {
      name: 'get_fight_summary',
      description: 'Composite TL;DR of specific fights: damage totals, healing totals, deaths, group composition, and top performers. Fetches multiple data types in a single batched request.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          report_code: { type: 'string', description: 'WCL report code (from get_recent_reports)' },
          fight_ids: { type: 'array', items: { type: 'number' }, description: 'Fight IDs to summarize' },
        },
        required: ['report_code', 'fight_ids'],
      },
    },
    {
      name: 'get_fight_damage',
      description: 'DPS and damage breakdown for specific fights. Returns per-player damage, DPS (pre-computed), and rank within the group.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          report_code: { type: 'string', description: 'WCL report code' },
          fight_ids: { type: 'array', items: { type: 'number' }, description: 'Fight IDs to analyze' },
          player_name: { type: 'string', description: 'Filter to a specific player' },
        },
        required: ['report_code', 'fight_ids'],
      },
    },
    {
      name: 'get_fight_healing',
      description: 'HPS and healing breakdown for specific fights. Returns per-player healing, HPS, and overhealing percentage.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          report_code: { type: 'string', description: 'WCL report code' },
          fight_ids: { type: 'array', items: { type: 'number' }, description: 'Fight IDs to analyze' },
          player_name: { type: 'string', description: 'Filter to a specific player' },
        },
        required: ['report_code', 'fight_ids'],
      },
    },
    {
      name: 'get_fight_damage_taken',
      description: 'Damage taken breakdown for specific fights. Shows per-player damage received with source abilities sorted by damage.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          report_code: { type: 'string', description: 'WCL report code' },
          fight_ids: { type: 'array', items: { type: 'number' }, description: 'Fight IDs to analyze' },
          player_name: { type: 'string', description: 'Filter to a specific player' },
        },
        required: ['report_code', 'fight_ids'],
      },
    },
    {
      name: 'get_character_deaths',
      description: 'Analyze deaths across recent fights. Aggregates death causes, frequency, and patterns. This is a compound tool that discovers reports and fetches data internally -- no need to chain multiple calls.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Character name (defaults to active character)' },
          realm: { type: 'string', description: 'Realm (defaults to active character)' },
          region: { type: 'string', description: 'Region (defaults to active character)' },
          report_code: { type: 'string', description: 'Limit to a specific report' },
          fight_ids: { type: 'array', items: { type: 'number' }, description: 'Limit to specific fights' },
          content_type: { type: 'string', enum: ['raid', 'mythicplus'], description: 'Filter by content type' },
          limit_reports: { type: 'number', description: 'Max reports to scan (default 5)' },
        },
      },
    },
    {
      name: 'get_character_casts',
      description: 'Ability usage data aggregated across recent fights. Shows cast counts and averages per fight. This is a compound tool that handles multi-report workflows internally.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Character name (defaults to active character)' },
          realm: { type: 'string', description: 'Realm (defaults to active character)' },
          region: { type: 'string', description: 'Region (defaults to active character)' },
          report_code: { type: 'string', description: 'Limit to a specific report' },
          fight_ids: { type: 'array', items: { type: 'number' }, description: 'Limit to specific fights' },
          content_type: { type: 'string', enum: ['raid', 'mythicplus'], description: 'Filter by content type' },
          limit_reports: { type: 'number', description: 'Max reports to scan (default 5)' },
        },
      },
    },
    {
      name: 'get_buff_uptime',
      description: 'Buff and debuff uptime tracking for specific fights. Returns per-player buff/debuff uptime percentages.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          report_code: { type: 'string', description: 'WCL report code' },
          fight_ids: { type: 'array', items: { type: 'number' }, description: 'Fight IDs to analyze' },
          player_name: { type: 'string', description: 'Filter to a specific player' },
          buff_type: { type: 'string', enum: ['buffs', 'debuffs', 'both'], description: 'Type: buffs, debuffs, or both (default both)' },
        },
        required: ['report_code', 'fight_ids'],
      },
    },
    {
      name: 'get_combatant_info',
      description: 'Player setup context: class, spec, and player details from a specific fight.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          report_code: { type: 'string', description: 'WCL report code' },
          fight_id: { type: 'number', description: 'Fight ID' },
          player_name: { type: 'string', description: 'Filter to a specific player' },
        },
        required: ['report_code', 'fight_id'],
      },
    },
    {
      name: 'get_encounter_rankings',
      description: 'Parse rankings for a character on specific encounters or zones. Shows percentile, best parse, and kill count.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Character name (defaults to active character)' },
          realm: { type: 'string', description: 'Realm (defaults to active character)' },
          region: { type: 'string', description: 'Region (defaults to active character)' },
          encounter_id: { type: 'number', description: 'Encounter ID for specific boss rankings' },
          zone_id: { type: 'number', description: 'Zone ID for zone-wide rankings' },
          difficulty: { type: 'number', description: 'Difficulty level (raid: 3=Normal, 4=Heroic, 5=Mythic)' },
          metric: { type: 'string', description: 'Metric: dps, hps, bossdps, etc.' },
        },
      },
    },
    {
      name: 'get_fight_events',
      description: 'Raw combat events for deep-dive analysis. Returns individual events with timestamps, sources, targets, abilities, and amounts. Use for questions the aggregate tools can\'t answer.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          offset: {type:'integer',minimum:0},
          limit: {type:'integer',minimum:1,maximum:200},
          report_code: { type: 'string', description: 'WCL report code' },
          fight_id: { type: 'number', description: 'Fight ID' },
          event_type: { type: 'string', enum: ['casts', 'damage-done', 'damage-taken', 'healing', 'buffs', 'debuffs', 'deaths'], description: 'Event type filter' },
          source_name: { type: 'string', description: 'Filter by source player name' },
          target_name: { type: 'string', description: 'Filter by target name' },
          ability_id: { type: 'number', description: 'Filter by ability ID' },
        },
        required: ['report_code', 'fight_id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result: unknown;

  switch (name) {
    case 'local_analysis': {
      try { result = await localAnalysis(wclClient, args); }
      catch (e) { result = {error:'local_analysis_failed', message:(e as Error).message}; }
      break;
    }
    case 'set_active_character': {
      const parsed = setActiveCharacterSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types and required fields.' };
      } else {
        result = await handleSetActiveCharacter(wclClient, parsed.data);
      }
      break;
    }
    case 'get_character_summary': {
      const parsed = getCharacterSummarySchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types.' };
      } else {
        result = await handleGetCharacterSummary(wclClient, parsed.data);
      }
      break;
    }
    case 'get_recent_reports': {
      const parsed = getRecentReportsSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types.' };
      } else {
        result = await handleGetRecentReports(wclClient, parsed.data);
      }
      break;
    }
    case 'get_fight_summary': {
      const parsed = getFightSummarySchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types. report_code and fight_ids are required.' };
      } else {
        result = await handleGetFightSummary(wclClient, parsed.data);
      }
      break;
    }
    case 'get_fight_damage': {
      const parsed = getFightDamageSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types. report_code and fight_ids are required.' };
      } else {
        result = await handleGetFightDamage(wclClient, parsed.data);
      }
      break;
    }
    case 'get_fight_healing': {
      const parsed = getFightHealingSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types. report_code and fight_ids are required.' };
      } else {
        result = await handleGetFightHealing(wclClient, parsed.data);
      }
      break;
    }
    case 'get_fight_damage_taken': {
      const parsed = getFightDamageTakenSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types. report_code and fight_ids are required.' };
      } else {
        result = await handleGetFightDamageTaken(wclClient, parsed.data);
      }
      break;
    }
    case 'get_character_deaths': {
      const parsed = getCharacterDeathsSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types.' };
      } else {
        result = await handleGetCharacterDeaths(wclClient, parsed.data);
      }
      break;
    }
    case 'get_character_casts': {
      const parsed = getCharacterCastsSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types.' };
      } else {
        result = await handleGetCharacterCasts(wclClient, parsed.data);
      }
      break;
    }
    case 'get_buff_uptime': {
      const parsed = getBuffUptimeSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types. report_code and fight_ids are required.' };
      } else {
        result = await handleGetBuffUptime(wclClient, parsed.data);
      }
      break;
    }
    case 'get_combatant_info': {
      const parsed = getCombatantInfoSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types. report_code and fight_id are required.' };
      } else {
        result = await handleGetCombatantInfo(wclClient, parsed.data);
      }
      break;
    }
    case 'get_encounter_rankings': {
      const parsed = getEncounterRankingsSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types.' };
      } else {
        result = await handleGetEncounterRankings(wclClient, parsed.data);
      }
      break;
    }
    case 'get_fight_events': {
      const parsed = getFightEventsSchema.safeParse(args);
      if (!parsed.success) {
        result = { error: 'invalid_args', message: parsed.error.message, suggestion: 'Check the argument types. report_code and fight_id are required.' };
      } else {
        result = await handleGetFightEvents(wclClient, parsed.data);
      }
      break;
    }
    default:
      result = { error: 'unknown_tool', message: `Unknown tool: ${name}`, suggestion: 'Check the available tools list.' };
  }

  const text = responseText(result);
  const isError = (typeof result === 'object' && result !== null && 'error' in result) || text.includes('\"error\":\"response_too_large\"');

  return {
    content: [{ type: 'text', text }],
    isError,
  };
});

// --- Resources ---

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'wcl://zones/current',
      name: 'Current WoW Season Zones',
      description: 'Current M+ dungeon pool and raid tier with encounter IDs and zone IDs',
      mimeType: 'application/json',
    },
    {
      uri: 'wcl://knowledge/wow',
      name: 'WoW Domain Knowledge',
      description: 'Class mechanics, dungeon mechanics, coaching heuristics for WoW performance analysis',
      mimeType: 'text/markdown',
    },
    {
      uri: 'wcl://session/active-character',
      name: 'Active Character',
      description: 'The current session\'s active character (set via set_active_character)',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case 'wcl://zones/current':
      return {
        contents: [{ uri, mimeType: 'application/json', text: getZonesResource() }],
      };
    case 'wcl://knowledge/wow':
      return {
        contents: [{ uri, mimeType: 'text/markdown', text: getKnowledgeResource() }],
      };
    case 'wcl://session/active-character':
      return {
        contents: [{ uri, mimeType: 'application/json', text: getActiveCharacterResource() }],
      };
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// --- Prompts ---

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'analyze-run',
      description: 'Analyze my most recent M+ run. Look at deaths, damage, healing, and damage taken.',
    },
    {
      name: 'death-report',
      description: 'Show me my death patterns across recent runs and identify the most common causes.',
    },
    {
      name: 'compare-runs',
      description: 'Compare my last two runs of a specific dungeon and highlight what changed.',
      arguments: [
        { name: 'dungeon', description: 'Dungeon name to compare', required: true },
      ],
    },
    {
      name: 'gear-check',
      description: 'Check my gear and talents from my most recent log.',
    },
    {
      name: 'ranking-overview',
      description: 'How do I rank compared to other players of my spec?',
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name } = request.params;

  switch (name) {
    case 'analyze-run':
      return {
        description: 'Analyze my most recent M+ run',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: 'Analyze my most recent M+ run. Start by finding my latest M+ report with get_recent_reports (content_type: mythicplus, limit: 1), then get a fight summary, and break down what went well and what I can improve. Focus on deaths, damage output, and any patterns you notice.',
            },
          },
        ],
      };
    case 'death-report':
      return {
        description: 'Death pattern analysis',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: 'Show me my death patterns across my recent M+ runs. What kills me the most? Are the deaths avoidable? Give me specific, actionable advice on how to die less.',
            },
          },
        ],
      };
    case 'compare-runs': {
      const dungeon = request.params.arguments?.dungeon ?? 'my most-run dungeon';
      return {
        description: `Compare recent ${dungeon} runs`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Compare my last two runs of ${dungeon}. Look at the fight summaries for both and highlight what changed -- deaths, damage, timing, and any improvements or regressions.`,
            },
          },
        ],
      };
    }
    case 'gear-check':
      return {
        description: 'Gear and talent review',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: 'Check my gear and talents from my most recent log. Flag anything that looks unusual or suboptimal.',
            },
          },
        ],
      };
    case 'ranking-overview':
      return {
        description: 'Ranking percentile overview',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: 'How do I rank compared to other players of my spec at my key level? Show me my parse percentiles across current content.',
            },
          },
        ],
      };
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// --- Start Server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('WCL MCP Server started', { version: '0.1.0' });
}

main().catch((error) => {
  logger.error('Server failed to start', { error: String(error) });
  process.exit(1);
});
