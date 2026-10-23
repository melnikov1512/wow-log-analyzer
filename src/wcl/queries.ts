// GraphQL query strings for the WCL API v2

export const RECENT_REPORTS_QUERY = `
query RecentReports($name: String!, $serverSlug: String!, $serverRegion: String!, $limit: Int!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      name
      classID
      recentReports(limit: $limit) {
        data {
          code
          startTime
          endTime
          title
          owner {
            name
          }
          fights(killType: Encounters) {
            id
            name
            keystoneLevel
            kill
            startTime
            endTime
            difficulty
            fightPercentage
          }
        }
      }
    }
  }
}
`;

export const FIGHT_TABLE_QUERY = `
query FightTable($code: String!, $fightIDs: [Int]!, $dataType: TableDataType!) {
  reportData {
    report(code: $code) {
      table(dataType: $dataType, fightIDs: $fightIDs)
    }
  }
}
`;

export const FIGHT_SUMMARY_QUERY = `
query FightSummary($code: String!, $fightIDs: [Int]!) {
  reportData {
    report(code: $code) {
      fights(fightIDs: $fightIDs) {
        id
        name
        startTime
        endTime
        keystoneLevel
        kill
        difficulty
        fightPercentage
      }
      masterData {
        actors(type: "Player") {
          id
          name
          type
          subType
          icon
        }
      }
      damageTable: table(dataType: DamageDone, fightIDs: $fightIDs)
      healingTable: table(dataType: Healing, fightIDs: $fightIDs)
      deathsTable: table(dataType: Deaths, fightIDs: $fightIDs)
    }
  }
}
`;

export const ENCOUNTER_RANKINGS_QUERY = `
query EncounterRankings($name: String!, $serverSlug: String!, $serverRegion: String!, $encounterID: Int!, $difficulty: Int, $metric: CharacterRankingMetricType) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      encounterRankings(encounterID: $encounterID, difficulty: $difficulty, metric: $metric)
    }
  }
}
`;

export const ZONE_RANKINGS_QUERY = `
query ZoneRankings($name: String!, $serverSlug: String!, $serverRegion: String!, $zoneID: Int!, $difficulty: Int, $metric: CharacterRankingMetricType) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      zoneRankings(zoneID: $zoneID, difficulty: $difficulty, metric: $metric)
    }
  }
}
`;

export const COMBATANT_INFO_QUERY = `
query CombatantInfo($code: String!, $fightIDs: [Int]!) {
  reportData {
    report(code: $code) {
      masterData {
        actors(type: "Player") {
          id
          name
          type
          subType
          icon
        }
      }
      fights(fightIDs: $fightIDs) {
        id
        name
        startTime
        endTime
      }
      playerDetails: table(dataType: Summary, fightIDs: $fightIDs)
    }
  }
}
`;

export const FIGHT_EVENTS_QUERY = `
query FightEvents($code: String!, $fightID: Int!, $startTime: Float!, $endTime: Float!, $dataType: EventDataType, $sourceID: Int, $targetID: Int, $abilityID: Float, $hostilityType: HostilityType) {
  reportData {
    report(code: $code) {
      events(fightIDs: [$fightID], startTime: $startTime, endTime: $endTime, dataType: $dataType, sourceID: $sourceID, targetID: $targetID, abilityID: $abilityID, hostilityType: $hostilityType, includeResources: true, useActorIDs: true, useAbilityIDs: true, limit: 10000) {
        data
        nextPageTimestamp
      }
    }
  }
}
`;

// Type definitions for WCL API responses

export interface WCLFight {
  id: number;
  name: string;
  keystoneLevel?: number;
  kill?: boolean;
  startTime: number;
  endTime: number;
  difficulty?: number;
  fightPercentage?: number;
}

export interface WCLReport {
  code: string;
  startTime: number;
  endTime: number;
  title: string;
  owner: { name: string };
  fights: WCLFight[];
}

export interface WCLCharacter {
  name: string;
  classID: number;
  recentReports: {
    data: WCLReport[];
  };
}

export interface WCLTableEntry {
  name: string;
  id: number;
  guid: number;
  type: string;
  icon: string;
  total: number;
  activeTime?: number;
  activeTimeReduced?: number;
  overheal?: number;
  totalReduced?: number;
  abilities?: Array<{
    name: string;
    total: number;
    type: number;
  }>;
  damageAbilities?: Array<{
    name: string;
    total: number;
    type: number;
  }>;
}

export interface WCLDeathEntry {
  name: string;
  id: number;
  guid: number;
  type: string;
  icon: string;
  deathTime: number;
  damage: {
    total: number;
    activeTime: number;
    activeTimeReduced: number;
    abilities: Array<{
      name: string;
      total: number;
      type: number;
    }>;
  };
  healing: {
    total: number;
    activeTime: number;
    activeTimeReduced: number;
    abilities: Array<{
      name: string;
      total: number;
      type: number;
    }>;
  };
  killingBlow?: {
    name: string;
    guid: number;
    type: number;
  };
}

export interface WCLActor {
  id: number;
  name: string;
  type: string;
  subType: string;
  icon: string;
}

export interface WCLTableResponse {
  data: {
    entries: WCLTableEntry[];
    totalTime: number;
  };
}

export interface WCLDeathsTableResponse {
  data: {
    entries: WCLDeathEntry[];
    totalTime: number;
  };
}

// WCL class ID to name mapping
export const WCL_CLASSES: Record<number, string> = {
  1: 'Death Knight',
  2: 'Druid',
  3: 'Hunter',
  4: 'Mage',
  5: 'Monk',
  6: 'Paladin',
  7: 'Priest',
  8: 'Rogue',
  9: 'Shaman',
  10: 'Warlock',
  11: 'Warrior',
  12: 'Demon Hunter',
  13: 'Evoker',
};
