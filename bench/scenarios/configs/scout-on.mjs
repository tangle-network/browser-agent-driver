export default {
  provider: 'openai',
  model: 'gpt-5.4',
  scout: {
    enabled: true,
    model: 'gpt-5.4',
    maxCandidates: 3,
    minTopScore: 12,
    maxScoreGap: 4,
    useVision: false,
  },
};
