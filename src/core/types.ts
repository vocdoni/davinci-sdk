// Basic JSON types
export type AnyJson = boolean | number | string | null | JsonArray | JsonMap | any;
export interface JsonMap {
    [key: string]: AnyJson;
}
export interface JsonArray extends Array<AnyJson> {}

// Custom metadata type
export type CustomMeta = AnyJson | JsonArray | JsonMap;

// Multi-language support
export type MultiLanguage<T> = {
    default: T;
    [lang: string]: T;
};

// Election choice types
export interface IChoice {
    title: MultiLanguage<string>;
    value: number;
    meta?: CustomMeta;
    results?: string;
    answer?: number;
}

export type Choice = Pick<IChoice, 'title' | 'value' | 'meta'>;

// Election question types
export interface IQuestion {
    title: MultiLanguage<string>;
    description?: MultiLanguage<string>;
    numAbstains?: string;
    meta?: CustomMeta;
    choices: Array<IChoice>;
}

export type Question = Pick<IQuestion, 'title' | 'description' | 'choices' | 'meta'>;

// Election result types
export enum ElectionResultsTypeNames {
    SINGLE_CHOICE_MULTIQUESTION = 'single-choice-multiquestion',
    MULTIPLE_CHOICE = 'multiple-choice',
    BUDGET = 'budget-based',
    APPROVAL = 'approval',
    QUADRATIC = 'quadratic',
}

// Properties for different election types
export interface AbstainProperties {
    canAbstain: boolean;
    abstainValues: Array<string>;
}

export interface ChoiceProperties {
    repeatChoice: boolean;
    numChoices: {
        min: number;
        max: number;
    };
}

export interface BudgetProperties {
    useCensusWeightAsBudget: boolean;
    maxBudget: number;
    minStep: number;
    forceFullBudget: boolean;
}

export interface ApprovalProperties {
    rejectValue: number;
    acceptValue: number;
}

export interface QuadraticProperties extends BudgetProperties {
    quadraticCost: number;
}

// Election result type definitions
export type ElectionResultsType =
    | {
          name: ElectionResultsTypeNames.SINGLE_CHOICE_MULTIQUESTION;
          properties: Record<string, never>;
      }
    | {
          name: ElectionResultsTypeNames.MULTIPLE_CHOICE;
          properties: AbstainProperties & ChoiceProperties;
      }
    | {
          name: ElectionResultsTypeNames.BUDGET;
          properties: BudgetProperties;
      }
    | {
          name: ElectionResultsTypeNames.APPROVAL;
          properties: ApprovalProperties;
      }
    | {
          name: ElectionResultsTypeNames.QUADRATIC;
          properties: QuadraticProperties;
      };

// Protocol version type
export type ProtocolVersion = '1.1' | '1.2';

// Main election metadata interface
export interface ElectionMetadata {
    version: ProtocolVersion;
    title: MultiLanguage<string>;
    description: MultiLanguage<string>;
    media: {
        header: string;
        logo: string;
    };
    meta?: {
        [key: string]: any;
    };
    questions: Array<IQuestion>;
    type: ElectionResultsType;
}

// Template for creating new election metadata
export const ElectionMetadataTemplate: ElectionMetadata = {
    version: '1.2',
    title: {
        default: '',
    },
    description: {
        default: '',
    },
    media: {
        header: '',
        logo: '',
    },
    meta: {},
    questions: [
        {
            title: {
                default: '',
            },
            description: {
                default: '',
            },
            meta: {},
            choices: [
                {
                    title: {
                        default: 'Yes',
                    },
                    value: 0,
                    meta: {},
                },
                {
                    title: {
                        default: 'No',
                    },
                    value: 1,
                    meta: {},
                },
            ],
        },
    ],
    type: {
        name: ElectionResultsTypeNames.SINGLE_CHOICE_MULTIQUESTION,
        properties: {},
    },
};

// Helper function to create a new metadata template
export const getElectionMetadataTemplate = (): ElectionMetadata => {
    return JSON.parse(JSON.stringify(ElectionMetadataTemplate));
};
