import { Box, Stepper, Step, StepLabel } from '@mui/material';

interface StepIndicatorProps {
  activeStep: number;
  steps: readonly string[];
}

export default function StepIndicator({ activeStep, steps }: StepIndicatorProps) {
  return (
    <Box sx={{ width: '100%', mb: 4 }}>
      <Stepper activeStep={activeStep} alternativeLabel>
        {steps.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>
    </Box>
  );
}
