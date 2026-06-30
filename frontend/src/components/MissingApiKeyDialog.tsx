'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/components/LanguageProvider';

interface MissingApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigure: () => void;
}

export function MissingApiKeyDialog({ open, onOpenChange, onConfigure }: MissingApiKeyDialogProps) {
  const { t } = useI18n();
  const handleConfigure = () => {
    onOpenChange(false);
    onConfigure();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('missingApiKey.title')}</DialogTitle>
          <DialogDescription>
            {t('missingApiKey.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleConfigure}>
            {t('common.configure')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
